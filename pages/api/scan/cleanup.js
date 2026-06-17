// Budgeted stale-product cleanup worker.
//
// Re-applies the same conservative retirement rules as the local
// scripts/disable-stale-products.mjs run, but evaluates candidates from the
// shared KV caches so the nightly job does not re-page sales or inventory.
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import {
  loadCatalogMeta,
  loadCatalogProducts,
  DEFAULT_SHARD_COUNT,
} from "../../../lib/catalog-store";
import { loadConsignEntries, loadConsignMeta } from "../../../lib/consignment-store";
import { loadInventoryCache, loadInventoryMeta } from "../../../lib/inventory-ledger";
import { markLsAuthError, markLsHealthy, setLsHealth, getLsToken, lsBase } from "../../../lib/ls-auth";
import { parseRetryAfterMs } from "../../../lib/ls-fetch";
import { loadSalesAgg, loadSalesStoreMeta } from "../../../lib/sales-store";
import { sessionOptions } from "../../../lib/session";
import { candidateReasonFromMeta, isConsignmentSku } from "../../../lib/stale-products";

const CHUNK_MS = 45_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_TTL_SECONDS = 30 * 24 * 3600;
const OPEN_PIDS_TTL_SECONDS = 48 * 3600;
const DEFAULT_WRITE_DELAY_MS = 250;
const DEFAULT_MAX_WRITES = 2000;
const DEFAULT_ANOMALY_MAX = 2000;
const DEFAULT_SINCE_DAYS = 365;
const WRITE_RETRIES = 4;

function utcDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function cleanupStateKey() {
  return "scan:cleanup:cursor";
}

function cleanupLogKey(dateKey) {
  return `scan:cleanup:log:${dateKey}`;
}

function cleanupOpenPidsKey(dateKey) {
  return `scan:cleanup:openpids:${dateKey}`;
}

function cleanupStatsKey(dateKey) {
  return `scan:cleanup:stats:${dateKey}`;
}

function positiveInt(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function envInt(name, fallback) {
  return positiveInt(process.env[name]) ?? fallback;
}

function queryInt(req, name, fallback) {
  const raw = Array.isArray(req.query[name]) ? req.query[name][0] : req.query[name];
  return positiveInt(raw) ?? fallback;
}

function openConsignmentPidsFromEntries(entries) {
  const blocked = new Set();
  for (const entry of Object.values(entries || {})) {
    if (!entry || entry.type !== "SUPPLIER") continue;
    for (const [pid, totals] of Object.entries(entry.perPid || {})) {
      const ordered = Math.max(0, Number(totals?.qtyOrdered || 0));
      const received = Math.max(0, Number(totals?.qtyReceived || 0));
      if (ordered > received) blocked.add(String(pid));
    }
  }
  return blocked;
}

async function loadOpenConsignmentPids(dateKey, entries) {
  const key = cleanupOpenPidsKey(dateKey);
  const cached = await kv.get(key);
  if (cached?.pids) return new Set(cached.pids.map(String));

  const pids = openConsignmentPidsFromEntries(entries);
  await kv.set(key, { pids: [...pids], ts: Date.now() }, { ex: OPEN_PIDS_TTL_SECONDS });
  return pids;
}

function hasCatalogCleanupFields(products) {
  const required = ["active", "hasInventory", "deletedAt"];
  for (const meta of Object.values(products || {})) {
    for (const field of required) {
      if (!Object.prototype.hasOwnProperty.call(meta || {}, field)) return false;
    }
  }
  return Object.keys(products || {}).length > 0;
}

function onHandMapFromCache(cache) {
  return new Map(Object.entries(cache?.onHand || {}).map(([pid, amount]) => [pid, Number(amount) || 0]));
}

function lastSoldMapFromAgg(agg) {
  const result = new Map();
  for (const [pid, totals] of Object.entries(agg || {})) {
    const lastSoldAt = Number(totals?.lastSoldAt || 0);
    if (lastSoldAt > 0) result.set(String(pid), lastSoldAt);
  }
  return result;
}

function emptyStats() {
  return {
    totalProducts: 0,
    inactive: 0,
    deleted: 0,
    nonInventory: 0,
    inStock: 0,
    recentSale: 0,
    openConsignment: 0,
    activeSeasonGuard: 0,
    nonConsignment: 0,
    candidate: 0,
    candidateConsignment: 0,
    candidateRegular: 0,
  };
}

function buildCandidates(products, context) {
  const stats = emptyStats();
  const candidates = [];
  for (const [pid, meta] of Object.entries(products || {})) {
    stats.totalProducts++;
    const reason = candidateReasonFromMeta(pid, meta, context);
    stats[reason]++;
    if (reason !== "candidate") continue;
    if (isConsignmentSku(meta?.sku)) stats.candidateConsignment++;
    else stats.candidateRegular++;
    candidates.push({ id: String(pid), meta });
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return { candidates, stats };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryWaitMs(response, attempt) {
  const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
  if (response.status === 429 && retryAfter != null) return Math.min(retryAfter, 30_000);
  return Math.min(2000 * 2 ** attempt, 30_000);
}

async function setProductActive({ base, token, id, active, deadline }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const pathname = `2026-04/products/${encodeURIComponent(id)}`;

  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
    const response = await fetch(`${base}/${pathname}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ details: { is_active: active } }),
    });
    if ((response.status === 429 || response.status === 503) && attempt < WRITE_RETRIES) {
      const waitMs = retryWaitMs(response, attempt);
      if (Date.now() + waitMs >= deadline) throw new Error("Cleanup write deadline reached");
      await sleep(waitMs);
      continue;
    }

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        markLsAuthError({ status: response.status, body: text.slice(0, 120) });
      }
      throw new Error(`LS PUT /${pathname} HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`LS PUT /${pathname} exhausted retries`);
}

async function loadRequiredCaches(shardCount = DEFAULT_SHARD_COUNT) {
  const [catalogMeta, inventoryMeta, salesMeta] = await Promise.all([
    loadCatalogMeta(kv),
    loadInventoryMeta(kv),
    loadSalesStoreMeta(kv),
  ]);
  if (!catalogMeta?.complete) throw new Error("Catalog cache is not complete");
  if (!inventoryMeta?.complete) throw new Error("Inventory cache is not complete");
  if (!salesMeta?.complete) throw new Error("Sales cache is not complete");

  const consignMeta = await loadConsignMeta(kv);
  if (!consignMeta?.complete) throw new Error("Consignment cache is not complete");

  const effectiveCatalogShards = catalogMeta.shardCount || shardCount;
  const [products, inventory, salesAgg, consignEntries] = await Promise.all([
    loadCatalogProducts(kv, effectiveCatalogShards),
    loadInventoryCache(kv, "__store__"),
    loadSalesAgg(kv, salesMeta.shardCount || shardCount),
    loadConsignEntries(kv, consignMeta.shardCount || shardCount),
  ]);
  if (!hasCatalogCleanupFields(products)) {
    throw new Error("Catalog cache is missing cleanup fields; run a catalog reset first");
  }
  return { products, inventory, salesAgg, consignEntries };
}

async function saveAudit(dateKey, rows) {
  await kv.set(cleanupLogKey(dateKey), rows, { ex: AUDIT_TTL_SECONDS });
}

async function saveState(dateKey, state) {
  await kv.set(cleanupStateKey(), { ...state, date: dateKey }, { ex: AUDIT_TTL_SECONDS });
}

async function saveStats(dateKey, stats) {
  await kv.set(cleanupStatsKey(dateKey), { ...stats, ts: Date.now() }, { ex: AUDIT_TTL_SECONDS });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuth) {
    const session = await getIronSession(req, res, sessionOptions);
    if (!session.authed) return res.status(401).json({ error: "Unauthorized" });
  }

  if (process.env.CLEANUP_ENABLED === "0") {
    return res.json({ ok: true, complete: true, disabled: true });
  }

  let token;
  try {
    token = await getLsToken();
  } catch (e) {
    return res.status(503).json({ error: "LS auth failed: " + e.message });
  }

  const dateKey = utcDateKey();
  const deadline = Date.now() + CHUNK_MS;
  const maxWrites = queryInt(req, "max_writes", envInt("CLEANUP_MAX_WRITES", DEFAULT_MAX_WRITES));
  const anomalyMax = queryInt(
    req,
    "anomaly_max",
    envInt("CLEANUP_ANOMALY_MAX", DEFAULT_ANOMALY_MAX)
  );
  const sinceDays = queryInt(req, "since_days", envInt("CLEANUP_SINCE_DAYS", DEFAULT_SINCE_DAYS));
  const writeDelayMs = queryInt(
    req,
    "write_delay_ms",
    envInt("CLEANUP_WRITE_DELAY_MS", DEFAULT_WRITE_DELAY_MS)
  );
  const base = lsBase();

  try {
    const { products, inventory, salesAgg, consignEntries } = await loadRequiredCaches();
    const openConsignmentPids = await loadOpenConsignmentPids(dateKey, consignEntries);
    const context = {
      onHand: onHandMapFromCache(inventory),
      lastSaleByPid: lastSoldMapFromAgg(salesAgg),
      regularCutoffMs: Date.now() - sinceDays * DAY_MS,
      consignmentCutoffMs: Date.now() - sinceDays * DAY_MS,
      openConsignmentPids,
      activeSeasonPids: new Set(),
    };
    const { candidates, stats } = buildCandidates(products, context);
    await saveStats(dateKey, stats);

    if (candidates.length > anomalyMax) {
      await setLsHealth(
        "warning",
        `cleanup anomaly: ${candidates.length} candidates exceeds max ${anomalyMax}`
      );
      return res.json({
        ok: true,
        complete: true,
        anomalyAborted: true,
        candidates: candidates.length,
        stats,
      });
    }

    const audit = (await kv.get(cleanupLogKey(dateKey))) || [];
    const loggedIds = new Set(audit.map((row) => String(row.id)));
    const rawState = (await kv.get(cleanupStateKey())) || {};
    const priorState = rawState.date === dateKey ? rawState : {};
    const state = {
      date: dateKey,
      cursor: Number(priorState.cursor || 0),
      written: Math.max(Number(priorState.written || 0), loggedIds.size),
      complete: priorState.complete === true,
      startedAt: priorState.startedAt || Date.now(),
    };

    if (state.complete) {
      return res.json({
        ok: true,
        complete: true,
        candidates: candidates.length,
        written: state.written,
        stats,
      });
    }

    let chunkWritten = 0;
    let skippedLogged = 0;
    while (
      state.cursor < candidates.length &&
      state.written < maxWrites &&
      Date.now() + writeDelayMs + 5000 < deadline
    ) {
      const candidate = candidates[state.cursor];
      state.cursor++;
      if (loggedIds.has(candidate.id)) {
        skippedLogged++;
        continue;
      }

      await setProductActive({ base, token, id: candidate.id, active: false, deadline });
      const row = {
        ts: new Date().toISOString(),
        id: candidate.id,
        sku: candidate.meta?.sku || "",
        previousActive: candidate.meta?.active,
        action: "deactivate",
        status: "ok",
      };
      audit.push(row);
      loggedIds.add(candidate.id);
      chunkWritten++;
      state.written++;
      await saveAudit(dateKey, audit);
      await saveState(dateKey, state);
      await sleep(writeDelayMs);
    }

    const capped = state.written >= maxWrites && state.cursor < candidates.length;
    state.complete = state.cursor >= candidates.length || capped;
    await saveState(dateKey, state);
    if (chunkWritten > 0) markLsHealthy();

    return res.json({
      ok: true,
      complete: state.complete,
      capped,
      candidates: candidates.length,
      written: state.written,
      chunkWritten,
      skippedLogged,
      cursor: state.cursor,
      auditKey: cleanupLogKey(dateKey),
      stats,
    });
  } catch (e) {
    console.error("[cleanup] failed:", e.message);
    await setLsHealth("warning", `cleanup failed: ${e.message}`);
    return res.status(503).json({ error: e.message });
  }
}
