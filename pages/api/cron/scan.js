// Cron endpoint — advances scans for all active seasons.
// Scheduled to fire hourly via vercel.json crons.
//
// Behavior differs by caller:
//   Vercel cron scheduler (CRON_SECRET header, no ?force/?driver) — loops
//     internally for its time budget, advancing all seasons as many steps as possible.
//     This lets one cron invocation complete an entire scan rather than one step per firing.
//   GitHub Actions driver (CRON_SECRET header, ?driver=1) — one bounded pass per
//     call, preserving shared-cache gates while returning frequent progress JSON.
//   UI "Sync from LS" button (?force=1, session auth) — one pass per call so the
//     browser loop can show live progress between calls.
import { kv } from "@vercel/kv";
import { SEASONS } from "../../../lib/seasons";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import {
  buildDriverResults,
  cacheDriveDeadline,
  computeAllDone,
  planSeasonWork,
  resolveLastFullTs,
  shouldRetrySeasonStep,
  shouldSkipCompletedDrive,
  shouldYieldForCache,
} from "../../../lib/scan-orchestrator";
import { loadScanDataSummary } from "../../../lib/scan-data-store";
import { loadCatalogMeta } from "../../../lib/catalog-store";
import { loadSalesStoreMeta } from "../../../lib/sales-store";
import { loadConsignMeta } from "../../../lib/consignment-store";
import { loadInventoryMeta } from "../../../lib/inventory-ledger";

const RESCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between full rescans
const FULL_REBUILD_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Carries the full-rebuild intent across the catalog-building yields: ?restart=1
// arrives on the first call but the cron yields (without stepping seasons) while
// the shared catalog builds, so later calls — which carry no ?restart — must
// still know a rebuild is owed. 12h covers the weekly workflow's 340-min budget.
const REBUILD_TS_KEY = "scan:rebuild:ts";
const REBUILD_TS_TTL_SECONDS = 12 * 3600;
// Overall response budget per invocation, SHARED by the cache drives and the
// season loop. Vercel kills this route at 300s, so stop starting child requests
// early enough that a slow child response can finish and we can still serialize
// JSON for the workflow driver.
// Raised from 120s to 150s so that after the (skippable) cache drives there is
// still enough of the shared budget left to clear the 75s season-step headroom
// gate and actually step seasons on the GitHub driver path. Stays well under the
// workflow's `curl --max-time 180` and Vercel's 300s maxDuration; the
// hasBudgetFor guard still prevents a step from starting without enough room.
const CRON_LOOP_DEADLINE_MS = 150 * 1000;
const CACHE_REQUEST_TIMEOUT_MS = 55 * 1000;
const STEP_REQUEST_TIMEOUT_MS = 70 * 1000;
const RESPONSE_OVERHEAD_MS = 5 * 1000;
// How many times the driver path retries a season whose step failed
// transiently (network/timeout/5xx) before abandoning it, so one transient LS
// hiccup can't fail an otherwise-green weekly sync. The workflow stall guard is
// the final backstop against a persistently failing season.
const STEP_MAX_ATTEMPTS = 3;
// Cap on how long the cold catalog build may run before yielding (to seasons if
// it finished, or to the next firing if not). Incremental syncs finish in ~1
// call; only the first-ever cold build approaches this cap, and it resumes
// across firings via buildOffset. Must be < CRON_LOOP_DEADLINE_MS.
const CATALOG_DRIVE_MS = 75 * 1000;
// Same idea for the store-wide sales cache: drive it to completion before
// stepping seasons so each season projects sales with zero 2.0/sales paging.
const SALES_DRIVE_MS = 75 * 1000;
// Gate the store-wide sales cache. Default on; set ENABLE_SALES_STORE=0 to fall
// back to per-season sales paging (step.js also auto-falls-back per run).
const ENABLE_SALES_STORE = process.env.ENABLE_SALES_STORE !== "0";
// Store-wide consignment cache (POs + returns) drive budget + gate.
const CONSIGN_DRIVE_MS = 75 * 1000;
const ENABLE_CONSIGN_STORE = process.env.ENABLE_CONSIGN_STORE !== "0";
// Store-wide live-inventory cache drive budget + gate. Driving it to completion
// here (sequentially) before stepping seasons stops every season from re-paging
// the full 2.0/inventory stream in parallel — the thundering herd that
// rate-limited LS and timed the 70s step out. Mirrors cron/delta's inventory drive.
const INVENTORY_DRIVE_MS = 75 * 1000;
const ENABLE_BULK_INVENTORY = process.env.ENABLE_BULK_INVENTORY !== "0";

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function currentSeasons() {
  const year = new Date().getFullYear();
  return SEASONS.filter((s) => {
    const m = s.id.match(/\d+$/);
    if (!m) return false;
    const y = parseInt("20" + m[0].slice(-2));
    return y >= year - 1;
  }).map((s) => s.id);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuth) {
    const session = await getIronSession(req, res, sessionOptions);
    if (!session.authed) return res.status(401).json({ error: "Unauthorized" });
  }

  const force = req.query.force === "1";
  const restartAll = req.query.restart === "1";
  const driverMode = req.query.driver === "1";
  // Loop internally only when called by the Vercel cron scheduler (not GitHub/UI).
  // GitHub uses ?driver=1 for quick progress JSON without bypassing cache gates.
  const usesCronGates = cronAuth && !force;
  const loopInternally = usesCronGates && !driverMode;

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${process.env.VERCEL_URL}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.CRON_SECRET}`,
  };

  const seasons = currentSeasons();

  // Persist the full-rebuild intent up front, before the catalog-building yields,
  // so it survives across cron calls even though only the first call carries
  // ?restart=1. Read the prior request timestamp on calls that don't restart.
  let rebuildTs = null;
  try {
    if (restartAll) {
      rebuildTs = Date.now();
      await kv.set(REBUILD_TS_KEY, rebuildTs, { ex: REBUILD_TS_TTL_SECONDS });
    } else {
      rebuildTs = Number(await kv.get(REBUILD_TS_KEY)) || null;
    }
  } catch (e) {
    console.error("[cron/scan] rebuild flag read/write failed:", e.message);
  }

  // Single shared deadline for this invocation. The catalog drive and the season
  // loop both respect it so their budgets cannot sum past maxDuration.
  const handlerStart = Date.now();
  const overallDeadline = handlerStart + CRON_LOOP_DEADLINE_MS;

  function hasBudgetFor(deadline, requestTimeoutMs) {
    if (!usesCronGates) return true;
    return (
      Date.now() + requestTimeoutMs + RESPONSE_OVERHEAD_MS < Math.min(deadline, overallDeadline)
    );
  }

  // Treat a shared cache as complete when its persisted KV meta says so. This is
  // the safety net the gates consult alongside the in-call drive result: a cache
  // already finished in KV (drive skipped for budget, or a transient drive error
  // returned null) must not re-trigger the idle "building" loop.
  async function cacheCompleteInKv(loadMeta) {
    try {
      const meta = await loadMeta(kv);
      return !!(meta && meta.complete);
    } catch (e) {
      return false;
    }
  }

  // Drive the shared catalog cache before stepping seasons so each season can
  // seed from scan:catalog:season:{season} with zero catalog API calls. Failures
  // are non-fatal — step.js falls back to scan:pids + lazy registration.
  async function driveCatalog() {
    // On the driver/UI path, skip the HTTP drive entirely when the catalog is
    // already complete in KV — re-paging it every call starves season stepping.
    // The internally-looping cron still tops it up incrementally.
    if (
      shouldSkipCompletedDrive({
        kvComplete: await cacheCompleteInKv(loadCatalogMeta),
        resetRequested: req.query.catalog === "1",
        loopInternally,
      })
    ) {
      return { cacheComplete: true, complete: true, version: null, added: 0, skipped: true };
    }
    // Real per-call budget for BOTH the cron loop and the GitHub driver path
    // (see cacheDriveDeadline). The do/while below still runs exactly one chunk
    // on the driver path (loopInternally === false) so it returns progress JSON
    // promptly, but that one chunk now actually executes.
    const catalogDeadline = cacheDriveDeadline({ driveMs: CATALOG_DRIVE_MS, overallDeadline });
    // Reset = a full cold rebuild of the shared catalog. Do this ONLY on an
    // explicit ?catalog=1, never on a weekly season rebuild (?restart=1): the
    // incremental top-up keeps the catalog current in ~1 call, so re-paging the
    // whole 200k+ catalog every week would be wasteful. The catalog still
    // cold-builds automatically whenever its cache is missing or incomplete.
    let resetFirst = req.query.catalog === "1";
    let last = null;
    do {
      if (!hasBudgetFor(catalogDeadline, CACHE_REQUEST_TIMEOUT_MS)) break;
      const q = resetFirst ? "?reset=1" : "";
      resetFirst = false;
      try {
        const r = await fetchWithTimeout(
          `${base}/api/scan/catalog${q}`,
          { method: "POST", headers },
          CACHE_REQUEST_TIMEOUT_MS
        );
        const body = await r.json().catch(() => null);
        if (body) last = body;
        if (!r.ok) {
          console.error(`[cron/scan] catalog HTTP ${r.status}: ${body?.error || ""}`);
          break;
        }
        // Stop driving once the cache is fully built (buckets written); otherwise
        // keep advancing the resumable cold build until the budget runs out.
        if (body?.cacheComplete) break;
      } catch (e) {
        console.error("[cron/scan] catalog drive failed:", e.message);
        break;
      }
    } while (loopInternally && hasBudgetFor(catalogDeadline, CACHE_REQUEST_TIMEOUT_MS));
    return last;
  }

  // Drive the store-wide sales cache (built once for the whole store) so each
  // season projects sales from the shared aggregate instead of paging 2.0/sales.
  // Mirrors driveCatalog; resumable across invocations via its version cursor.
  async function driveSales() {
    if (
      shouldSkipCompletedDrive({
        kvComplete: await cacheCompleteInKv(loadSalesStoreMeta),
        resetRequested: req.query.sales === "1",
        loopInternally,
      })
    ) {
      return { cacheComplete: true, complete: true, version: null, skipped: true };
    }
    const salesDeadline = cacheDriveDeadline({ driveMs: SALES_DRIVE_MS, overallDeadline });
    const resetFirst = req.query.sales === "1";
    let last = null;
    let first = true;
    do {
      if (!hasBudgetFor(salesDeadline, CACHE_REQUEST_TIMEOUT_MS)) break;
      const q = first && resetFirst ? "?reset=1" : "";
      first = false;
      try {
        const r = await fetchWithTimeout(
          `${base}/api/scan/sales-cache${q}`,
          { method: "POST", headers },
          CACHE_REQUEST_TIMEOUT_MS
        );
        const body = await r.json().catch(() => null);
        if (body) last = body;
        if (!r.ok) {
          console.error(`[cron/scan] sales-cache HTTP ${r.status}: ${body?.error || ""}`);
          break;
        }
        if (body?.cacheComplete) break;
      } catch (e) {
        console.error("[cron/scan] sales drive failed:", e.message);
        break;
      }
    } while (loopInternally && hasBudgetFor(salesDeadline, CACHE_REQUEST_TIMEOUT_MS));
    return last;
  }

  // Drive the store-wide consignment cache (POs + vendor returns). Mirrors
  // driveCatalog/driveSales; resumable across invocations via its version cursor.
  async function driveConsign() {
    if (
      shouldSkipCompletedDrive({
        kvComplete: await cacheCompleteInKv(loadConsignMeta),
        resetRequested: req.query.consign === "1",
        loopInternally,
      })
    ) {
      return { cacheComplete: true, complete: true, added: 0, skipped: true };
    }
    const consignDeadline = cacheDriveDeadline({ driveMs: CONSIGN_DRIVE_MS, overallDeadline });
    const resetFirst = req.query.consign === "1";
    let last = null;
    let first = true;
    do {
      if (!hasBudgetFor(consignDeadline, CACHE_REQUEST_TIMEOUT_MS)) break;
      const q = first && resetFirst ? "?reset=1" : "";
      first = false;
      try {
        const r = await fetchWithTimeout(
          `${base}/api/scan/consign-cache${q}`,
          { method: "POST", headers },
          CACHE_REQUEST_TIMEOUT_MS
        );
        const body = await r.json().catch(() => null);
        if (body) last = body;
        if (!r.ok) {
          console.error(`[cron/scan] consign-cache HTTP ${r.status}: ${body?.error || ""}`);
          break;
        }
        if (body?.cacheComplete) break;
      } catch (e) {
        console.error("[cron/scan] consign drive failed:", e.message);
        break;
      }
    } while (loopInternally && hasBudgetFor(consignDeadline, CACHE_REQUEST_TIMEOUT_MS));
    return last;
  }

  // Drive the store-wide live-inventory cache (one shared 2.0/inventory pull).
  // Mirrors driveConsign; resumable across invocations via its version cursor.
  // Pre-building it here means each season's inventory phase just READS on-hand
  // from the cache instead of every season re-paging the full stream in parallel.
  async function driveInventory() {
    if (
      shouldSkipCompletedDrive({
        kvComplete: await cacheCompleteInKv(loadInventoryMeta),
        resetRequested: req.query.inventory === "1",
        loopInternally,
      })
    ) {
      return { cacheComplete: true, complete: true, version: null, skipped: true };
    }
    const inventoryDeadline = cacheDriveDeadline({ driveMs: INVENTORY_DRIVE_MS, overallDeadline });
    const resetFirst = req.query.inventory === "1";
    let last = null;
    let first = true;
    do {
      if (!hasBudgetFor(inventoryDeadline, CACHE_REQUEST_TIMEOUT_MS)) break;
      const q = first && resetFirst ? "?reset=1" : "";
      first = false;
      try {
        const r = await fetchWithTimeout(
          `${base}/api/scan/inventory-cache${q}`,
          { method: "POST", headers },
          CACHE_REQUEST_TIMEOUT_MS
        );
        const body = await r.json().catch(() => null);
        if (body) last = body;
        if (!r.ok) {
          console.error(`[cron/scan] inventory-cache HTTP ${r.status}: ${body?.error || ""}`);
          break;
        }
        if (body?.cacheComplete) break;
      } catch (e) {
        console.error("[cron/scan] inventory drive failed:", e.message);
        break;
      }
    } while (loopInternally && hasBudgetFor(inventoryDeadline, CACHE_REQUEST_TIMEOUT_MS));
    return last;
  }

  let catalogResult = null;
  try {
    catalogResult = await driveCatalog();
    if (catalogResult) {
      console.warn(
        `[cron/scan] catalog: complete=${catalogResult.complete} version=${catalogResult.version} added=${catalogResult.added}`
      );
    }
  } catch (e) {
    console.error("[cron/scan] catalog drive error:", e.message);
  }

  // If the shared catalog cache is not fully built, yield this whole invocation
  // to the build: don't step seasons yet (with no per-season bucket they'd fall
  // back to the slow legacy per-season catalog scan, defeating the optimization).
  // A missing/failed catalog response counts as "not complete" so a timeout or
  // transient error doesn't leak seasons onto the fallback path. The driver loop
  // calls us again to continue the build; this returns promptly under maxDuration.
  if (
    usesCronGates &&
    shouldYieldForCache({
      driveResult: catalogResult,
      kvComplete: await cacheCompleteInKv(loadCatalogMeta),
    })
  ) {
    return res.json({
      ok: true,
      allDone: false,
      catalogBuilding: true,
      catalog: {
        complete: false,
        cacheComplete: false,
        version: (catalogResult && catalogResult.version) ?? null,
        added: (catalogResult && catalogResult.added) ?? 0,
      },
      results: [],
    });
  }

  // Catalog is built. Drive the sales cache next (it needs the catalog price
  // map). Yield if it isn't complete yet so seasons never page sales themselves.
  let salesResult = null;
  if (ENABLE_SALES_STORE) {
    try {
      salesResult = await driveSales();
      if (salesResult) {
        console.warn(
          `[cron/scan] sales: complete=${salesResult.complete} version=${salesResult.metaVersion ?? salesResult.version}`
        );
      }
    } catch (e) {
      console.error("[cron/scan] sales drive error:", e.message);
    }
    if (
      usesCronGates &&
      shouldYieldForCache({
        driveResult: salesResult,
        kvComplete: await cacheCompleteInKv(loadSalesStoreMeta),
      })
    ) {
      return res.json({
        ok: true,
        allDone: false,
        salesBuilding: true,
        sales: {
          complete: false,
          cacheComplete: false,
          version: (salesResult && (salesResult.metaVersion ?? salesResult.version)) ?? null,
        },
        results: [],
      });
    }
  }

  // Drive the store-wide consignment cache last (it projects per-season buckets
  // using the catalog pid sets). Yield if not complete so seasons never re-page
  // consignment headers or PO line items themselves.
  let consignResult = null;
  if (ENABLE_CONSIGN_STORE) {
    try {
      consignResult = await driveConsign();
      if (consignResult) {
        console.warn(
          `[cron/scan] consign: complete=${consignResult.complete} added=${consignResult.added}`
        );
      }
    } catch (e) {
      console.error("[cron/scan] consign drive error:", e.message);
    }
    if (
      usesCronGates &&
      shouldYieldForCache({
        driveResult: consignResult,
        kvComplete: await cacheCompleteInKv(loadConsignMeta),
      })
    ) {
      return res.json({
        ok: true,
        allDone: false,
        consignBuilding: true,
        consign: { complete: false, cacheComplete: false },
        results: [],
      });
    }
  }

  // Drive the store-wide live-inventory cache before stepping seasons so each
  // season reads on-hand from the shared cache. Yield if not complete so no
  // season re-pages the full 2.0/inventory stream itself (the timeout cause).
  let inventoryResult = null;
  if (ENABLE_BULK_INVENTORY) {
    try {
      inventoryResult = await driveInventory();
      if (inventoryResult) {
        console.warn(
          `[cron/scan] inventory: complete=${inventoryResult.complete} version=${inventoryResult.version}`
        );
      }
    } catch (e) {
      console.error("[cron/scan] inventory drive error:", e.message);
    }
    if (
      usesCronGates &&
      shouldYieldForCache({
        driveResult: inventoryResult,
        kvComplete: await cacheCompleteInKv(loadInventoryMeta),
      })
    ) {
      return res.json({
        ok: true,
        allDone: false,
        inventoryBuilding: true,
        inventory: {
          complete: false,
          cacheComplete: false,
          version: (inventoryResult && inventoryResult.version) ?? null,
        },
        results: [],
      });
    }
  }

  let kvResults;
  try {
    kvResults = await Promise.all(
      seasons.map((season) =>
        Promise.all([
          kv.get(`scan:job:${season}`),
          force ? Promise.resolve(null) : loadScanDataSummary(kv, season),
          kv.get(`scan:lastFull:${season}`),
        ])
      )
    );
  } catch (e) {
    console.error("[cron/scan] KV read failed:", e.message);
    return res.status(503).json({ error: "KV read failed: " + e.message });
  }

  const CONCURRENCY = 3;

  // Build per-season work items
  const seasonState = seasons.map((season, i) => {
    const [job, data, lastFull] = kvResults[i];
    const phase = job ? job.phase : null;
    const lastTs = (job && job.ts) || (data && data.ts) || null;
    const msSinceScan = lastTs ? Date.now() - lastTs : Infinity;
    // Prefer the lastFull embedded in the done job record so a single scan:job read is
    // authoritative even if the separate scan:lastFull key lags — avoids re-restarting a
    // season that just finished a full rebuild in this cycle.
    const lastFullTs = resolveLastFullTs(lastFull, job);

    const plan = planSeasonWork({
      phase,
      scanMode: job?.scanMode,
      hasData: !!data,
      msSinceScan,
      lastFullTs,
      startedAt: job?.startedAt ?? null,
      rebuildTs,
      restartAll,
      now: Date.now(),
      rescanIntervalMs: RESCAN_INTERVAL_MS,
      fullRebuildIntervalMs: FULL_REBUILD_INTERVAL_MS,
    });

    if (plan.skip) {
      return {
        season,
        phase,
        restart: plan.restart,
        mode: plan.mode,
        done: true,
        action: "skipped",
      };
    }
    return { season, phase, restart: plan.restart, mode: plan.mode, done: false, action: null };
  });

  async function stepSeason(ss) {
    try {
      const r = await fetchWithTimeout(
        `${base}/api/scan/step?season=${encodeURIComponent(ss.season)}&restart=${ss.restart}&mode=${ss.mode}`,
        { method: "POST", headers },
        STEP_REQUEST_TIMEOUT_MS
      );
      const text = await r.text();
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { error: text.slice(0, 300) };
      }
      ss.restart = "0";
      if (!r.ok) {
        // 5xx = transient (retry on the driver path); 4xx = terminal.
        ss.attempts = (ss.attempts || 0) + 1;
        ss.done = !shouldRetrySeasonStep({
          loopInternally,
          transient: r.status >= 500,
          attempts: ss.attempts,
          maxAttempts: STEP_MAX_ATTEMPTS,
        });
        ss.action = "error";
        ss.phase = json.phase || ss.phase || null;
        return {
          season: ss.season,
          action: "error",
          phase: ss.phase,
          mode: ss.mode,
          status: r.status,
          error: json.error || json.message || text.slice(0, 300),
        };
      }
      ss.phase = json.phase;
      ss.mode = json.mode || ss.mode;
      if (json.phase === "done") ss.done = true;
      if (json.phase === "error") {
        ss.done = !loopInternally;
        ss.action = "error";
      } else {
        ss.action = "advanced";
      }
      return {
        season: ss.season,
        action: ss.action,
        phase: json.phase,
        mode: ss.mode,
        progress: json.progress,
      };
    } catch (e) {
      // Network error / fetch timeout = transient → retry on the driver path.
      ss.attempts = (ss.attempts || 0) + 1;
      ss.done = !shouldRetrySeasonStep({
        loopInternally,
        transient: true,
        attempts: ss.attempts,
        maxAttempts: STEP_MAX_ATTEMPTS,
      });
      ss.action = "error";
      return { season: ss.season, action: "error", error: e.message };
    }
  }

  if (loopInternally) {
    // Cron path: loop for the remaining shared budget, advancing all seasons.
    const loopStart = Date.now();
    while (hasBudgetFor(overallDeadline, STEP_REQUEST_TIMEOUT_MS)) {
      const pending = seasonState.filter((s) => !s.done);
      if (pending.length === 0) break;

      const batch = pending.slice(0, CONCURRENCY);
      const batchResults = await Promise.all(batch.map(stepSeason));

      // Round-robin: move just-processed seasons to back so others get turns
      batch.forEach((ss) => {
        if (!ss.done) {
          const idx = seasonState.indexOf(ss);
          seasonState.splice(idx, 1);
          seasonState.push(ss);
        }
      });

      console.warn(
        "[cron/scan] pass:",
        batchResults.map((r) => `${r.season}=${r.phase || r.error}`).join(" ")
      );
    }

    const allDone = computeAllDone(seasonState);
    // The rebuild cycle is complete once every season has finished, so clear the
    // intent flag; otherwise a later nightly call would force a needless rebuild.
    if (allDone && rebuildTs) {
      try {
        await kv.del(REBUILD_TS_KEY);
      } catch (e) {
        console.error("[cron/scan] rebuild flag clear failed:", e.message);
      }
    }
    console.warn(
      `[cron/scan] finished in ${Math.round((Date.now() - loopStart) / 1000)}s, allDone=${allDone}`
    );
    return res.json({
      ok: true,
      allDone,
      results: seasonState.map((s) => ({
        season: s.season,
        action: s.action || "skipped",
        phase: s.phase,
        mode: s.mode,
      })),
    });
  } else {
    // UI/GitHub driver path: step as many season batches as the shared budget
    // allows (with round-robin so every season gets turns across calls), then
    // return progress JSON INCLUDING allDone so the workflow can detect
    // completion. Returns promptly once the budget is spent. For the UI path
    // (force=1) hasBudgetFor is always true, so it steps one batch and returns.
    const stepResults = [];
    while (hasBudgetFor(overallDeadline, STEP_REQUEST_TIMEOUT_MS)) {
      const pending = seasonState.filter((s) => !s.done);
      if (pending.length === 0) break;

      const batch = pending.slice(0, CONCURRENCY);
      const batchResults = await Promise.all(batch.map(stepSeason));
      stepResults.push(...batchResults);

      // Round-robin: move just-processed-but-unfinished seasons to the back so
      // others get a turn before we revisit them.
      batch.forEach((ss) => {
        if (!ss.done) {
          const idx = seasonState.indexOf(ss);
          seasonState.splice(idx, 1);
          seasonState.push(ss);
        }
      });

      // The UI path (force=1) bypasses the budget gate; cap it at one batch per
      // call so the browser loop keeps showing live progress between requests.
      if (!usesCronGates) break;
    }

    const results = buildDriverResults(seasonState, stepResults);
    const allDone = computeAllDone(seasonState);
    // Mirror the cron path: clear the rebuild intent once the cycle is complete
    // so a later nightly call doesn't force a needless rebuild.
    if (allDone && rebuildTs) {
      try {
        await kv.del(REBUILD_TS_KEY);
      } catch (e) {
        console.error("[cron/scan] rebuild flag clear failed:", e.message);
      }
    }
    return res.json({ ok: true, allDone, results });
  }
}
