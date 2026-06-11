// Cron endpoint — advances scans for all active seasons.
// Scheduled to fire hourly via vercel.json crons.
//
// Behavior differs by caller:
//   Vercel cron scheduler (CRON_SECRET header, no ?force) — loops internally
//     for its full time budget, advancing all seasons as many steps as possible.
//     This lets one cron invocation complete an entire scan rather than one step per firing.
//   UI "Sync from LS" button (?force=1, session auth) — one pass per call so the
//     browser loop can show live progress between calls.
import { kv } from "@vercel/kv";
import { SEASONS } from "../../../lib/seasons";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

const RESCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between full rescans
const FULL_REBUILD_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Overall internal time budget per invocation, SHARED by the catalog drive and
// the season loop. maxDuration is 300s (capped at 60s on Hobby); this stays
// under it with margin for one final ~60s sub-request.
const CRON_LOOP_DEADLINE_MS = 230 * 1000;
// Cap on how long the cold catalog build may run before yielding (to seasons if
// it finished, or to the next firing if not). Incremental syncs finish in ~1
// call; only the first-ever cold build approaches this cap, and it resumes
// across firings via buildOffset. Must be < CRON_LOOP_DEADLINE_MS.
const CATALOG_DRIVE_MS = 150 * 1000;

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
  // Loop internally only when called by the Vercel cron scheduler (not the UI).
  // UI calls use ?force=1 and need quick per-call responses for progress display.
  const loopInternally = cronAuth && !force;

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${process.env.VERCEL_URL}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.CRON_SECRET}`,
  };

  const seasons = currentSeasons();

  // Single shared deadline for this invocation. The catalog drive and the season
  // loop both respect it so their budgets cannot sum past maxDuration.
  const handlerStart = Date.now();
  const overallDeadline = handlerStart + CRON_LOOP_DEADLINE_MS;

  // Drive the shared catalog cache before stepping seasons so each season can
  // seed from scan:catalog:season:{season} with zero catalog API calls. Failures
  // are non-fatal — step.js falls back to scan:pids + lazy registration.
  async function driveCatalog() {
    const catalogDeadline = loopInternally
      ? Math.min(Date.now() + CATALOG_DRIVE_MS, overallDeadline)
      : Date.now();
    let resetFirst = restartAll;
    let last = null;
    do {
      const q = resetFirst ? "?reset=1" : "";
      resetFirst = false;
      try {
        const r = await fetch(`${base}/api/scan/catalog${q}`, { method: "POST", headers });
        last = await r.json().catch(() => ({}));
        if (!r.ok || last?.complete) break;
      } catch (e) {
        console.error("[cron/scan] catalog drive failed:", e.message);
        break;
      }
    } while (Date.now() < catalogDeadline);
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

  // If the cold build is still in progress, yield this whole invocation to it:
  // don't step seasons yet (with no per-season bucket they'd fall back to the
  // slow legacy per-season catalog scan). The driver loop calls us again to
  // continue the build; this returns promptly, well under maxDuration.
  if (loopInternally && catalogResult && catalogResult.complete === false) {
    return res.json({
      ok: true,
      allDone: false,
      catalogBuilding: true,
      catalog: {
        complete: false,
        version: catalogResult.version ?? null,
        added: catalogResult.added ?? 0,
      },
      results: [],
    });
  }

  let kvResults;
  try {
    kvResults = await Promise.all(
      seasons.map((season) =>
        Promise.all([
          kv.get(`scan:job:${season}`),
          force ? Promise.resolve(null) : kv.get(`scan:data:${season}`),
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
    const lastFullTs = Number(lastFull || 0) || null;
    const fullDue = !lastFullTs || Date.now() - lastFullTs >= FULL_REBUILD_INTERVAL_MS;

    let restart = "0";
    let mode = job?.scanMode || "incremental";
    if (restartAll) {
      restart = "1";
      mode = "full";
    } else if (!phase || phase === "done" || phase === "error") {
      if (msSinceScan < RESCAN_INTERVAL_MS) {
        return { season, phase, restart, mode, done: true, action: "skipped" };
      }
      if (!data || fullDue) {
        restart = "1";
        mode = "full";
      } else {
        mode = "incremental";
      }
    }

    return { season, phase, restart, mode, done: false, action: null };
  });

  async function stepSeason(ss) {
    try {
      const r = await fetch(
        `${base}/api/scan/step?season=${encodeURIComponent(ss.season)}&restart=${ss.restart}&mode=${ss.mode}`,
        { method: "POST", headers }
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
        ss.done = true;
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
      if (json.phase === "done" || json.phase === "error") ss.done = true;
      ss.action = "advanced";
      return {
        season: ss.season,
        action: ss.action,
        phase: json.phase,
        mode: ss.mode,
        progress: json.progress,
      };
    } catch (e) {
      ss.done = true;
      ss.action = "error";
      return { season: ss.season, action: "error", error: e.message };
    }
  }

  if (loopInternally) {
    // Cron path: loop for the remaining shared budget, advancing all seasons.
    const loopStart = Date.now();
    while (Date.now() < overallDeadline) {
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

    const allDone = seasonState.every((s) => s.done);
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
    // UI path: one pass, return quickly so the browser loop can show progress
    const results = [];
    for (let i = 0; i < seasonState.length; i += CONCURRENCY) {
      const batch = seasonState.slice(i, i + CONCURRENCY).filter((s) => !s.done);
      const batchResults = await Promise.all(batch.map(stepSeason));
      results.push(...batchResults);
    }
    // Include skipped seasons in results
    seasonState
      .filter((s) => s.done && s.action === "skipped")
      .forEach((s) => results.push({ season: s.season, action: "skipped" }));
    return res.json({ ok: true, results });
  }
}
