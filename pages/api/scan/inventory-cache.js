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

const CHUNK_MS = 45000;

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
