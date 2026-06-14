// Budgeted endpoint that advances the store-wide inventory cache one chunk at a
// time. cron/delta drives this to completion before fanning out per-season
// deltas, so each season READS live on-hand from the shared cache instead of
// every season re-paging the full 2.0/inventory stream in parallel — which
// exhausted the LS rate limit and timed the delta function out (a single
// rate-limited fetch could back off past the 60s function cap).
//
// The cache is store-wide (one shared key) and version-incremental, so normal
// runs page only changed inventory; only the first-ever build (or an explicit
// ?reset=1) pays the full inventory page cost, ONCE for the whole store.
//
// Auth matches cron/scan: CRON_SECRET bearer OR iron-session.
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { makeLsFetch } from "../../../lib/ls-fetch";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { syncInventoryCache } from "../../../lib/inventory-ledger";

// Paging budget per chunk. The cron/scan driver aborts each drive at
// CACHE_REQUEST_TIMEOUT_MS (55s); if this child hadn't RETURNED by then the
// parent's abort only stops it WAITING — the child keeps running to its
// maxDuration, so the next driver call spawns a SECOND concurrent build (the
// thundering herd that doubles LS request consumption and stalls the cold
// build). So the chunk must finish well under 55s.
//
// Budget breakdown: paging is LS-rate-limited (~950 req / 5 min), and each
// periodic checkpoint rewrites the touched store shards (which grow as the cold
// build accumulates ~110k products). 25s of paging plus the last in-flight page
// and the final incremental checkpoint returns comfortably < ~45s, leaving a
// safe margin below the 55s parent abort. The cold build simply spans a few
// more (non-overlapping) driver calls instead of fewer overlapping ones.
const CHUNK_MS = 25000;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuth) {
    const session = await getIronSession(req, res, sessionOptions);
    if (!session.authed) return res.status(401).json({ error: "Unauthorized" });
  }

  let token;
  try {
    token = await getLsToken();
  } catch (e) {
    return res.status(503).json({ error: "LS auth failed: " + e.message });
  }

  const base = lsBase();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const lsFetch = makeLsFetch({ base, headers });
  const deadline = Date.now() + CHUNK_MS;
  const reset = req.query.reset === "1" || req.query.inventory === "1";

  try {
    // The store-wide inventory cache is season-agnostic (one shared key), so the
    // season label here is cosmetic — any value writes/reads the same cache.
    const result = await syncInventoryCache(kv, "__store__", lsFetch, { reset, deadline });
    return res.json({
      complete: result.done,
      cacheComplete: result.done,
      version: result.version,
      pages: result.pages,
      calls: lsFetch.callStats,
    });
  } catch (e) {
    console.error("[inventory-cache] sync failed:", e.message);
    return res.status(503).json({ error: e.message });
  }
}
