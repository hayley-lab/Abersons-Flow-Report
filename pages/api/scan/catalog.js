// Budgeted endpoint that advances the store-wide catalog cache one chunk at a
// time. The cron orchestrator drives this to completion before stepping seasons.
// Because the cache is version-incremental, normal runs do ~0-2 pages; only the
// first-ever build pays the full catalog page cost.
//
// On completion it re-buckets the full catalog into per-season scan:pids-shaped
// blobs (scan:catalog:season:{season}) so each season seeds with zero API calls.
//
// Auth matches cron/scan: CRON_SECRET bearer OR iron-session.
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { makeLsFetch } from "../../../lib/ls-fetch";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { SEASONS } from "../../../lib/seasons";
import { loadCatalogMeta, syncCatalogCache, writeSeasonBuckets } from "../../../lib/catalog-store";

// Per-call work budget, kept under the 60s function maxDuration.
const CHUNK_MS = 45000;

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
  const reset = req.query.reset === "1" || req.query.catalog === "1";

  try {
    const result = await syncCatalogCache(kv, lsFetch, { reset, deadline });

    // When the sync run has drained (cold build fully paged, or incremental
    // reached the end of the change stream), re-bucket the full catalog so every
    // season has a fresh seed blob.
    let bucketed = 0;
    if (result.done) {
      const seasons = currentSeasons();
      await writeSeasonBuckets(kv, seasons);
      bucketed = seasons.length;
    }

    // Surface the durable cursor so the cold build's convergence is observable
    // across calls (buildOffset advances toward the full catalog size).
    const meta = await loadCatalogMeta(kv);

    return res.json({
      complete: result.done,
      cacheComplete: result.complete,
      version: result.version,
      added: result.added,
      pages: result.pages,
      buildOffset: meta ? meta.buildOffset : null,
      bucketed,
      calls: lsFetch.callStats,
    });
  } catch (e) {
    console.error("[catalog] sync failed:", e.message);
    return res.status(503).json({ error: e.message });
  }
}
