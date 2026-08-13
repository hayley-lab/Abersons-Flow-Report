// Budgeted endpoint that advances the store-wide consignment cache (POs + vendor
// returns) one chunk at a time. The cron orchestrator drives it to completion
// before stepping seasons, so each season projects ordered/received/returned qty
// from the shared cache with zero per-PO line-item fetches.
//
// On completion it projects per-season buckets (scan:consign:season:{season})
// using each season's catalog pid set + scan date range.
//
// Auth matches cron/scan: CRON_SECRET bearer OR iron-session.
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { makeLsFetch } from "../../../lib/ls-fetch";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { SEASONS } from "../../../lib/seasons";
import { seasonScanDateRange } from "../../../lib/flow-math";
import { loadSeasonBucket } from "../../../lib/catalog-store";
import {
  loadConsignMeta,
  seasonProjectionInputs,
  syncConsignmentStore,
  writeSeasonConsignBuckets,
} from "../../../lib/consignment-store";
import { loadScanData } from "../../../lib/scan-data-store";

// Leave most of the function window to checkpoint touched shards and, on the
// draining call, project all season buckets. A 45s paging window plus projection
// repeatedly exceeded the old 55s parent timeout, so the refresh never observed
// `complete: true`.
const CHUNK_MS = 25000;

function currentSeasons() {
  const year = new Date().getFullYear();
  return SEASONS.filter((s) => {
    const m = s.id.match(/\d+$/);
    if (!m) return false;
    const y = parseInt("20" + m[0].slice(-2));
    return y >= year - 1;
  }).map((s) => s.id);
}

// Earliest scan-range start across active seasons — the store pages headers from
// here; per-season date rules are reapplied at projection.
function globalConsignDateFrom(seasons) {
  return (
    seasons
      .map((s) => seasonScanDateRange(s).start)
      .filter(Boolean)
      .sort()[0] || ""
  );
}

function parseKv(val) {
  if (!val) return null;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return val;
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
  const reset = req.query.reset === "1" || req.query.consign === "1";

  try {
    const seasons = currentSeasons();
    const dateFrom = globalConsignDateFrom(seasons);
    const result = await syncConsignmentStore(kv, lsFetch, { reset, deadline, dateFrom });

    // When fully built, project per-season buckets using each season's catalog
    // pid set (the season's product universe) and its scan date range.
    let bucketed = 0;
    if (result.done) {
      const [catalogBuckets, priorScanData] = await Promise.all([
        Promise.all(seasons.map((s) => loadSeasonBucket(kv, s))),
        Promise.all(seasons.map((s) => loadScanData(kv, s))),
      ]);
      const { seasonPidSets, scanRanges, pidToSku } = seasonProjectionInputs(seasons, {
        catalogBuckets: catalogBuckets.map(parseKv),
        priorData: priorScanData.map(parseKv),
      });
      await writeSeasonConsignBuckets(kv, seasons, { seasonPidSets, scanRanges, pidToSku });
      bucketed = seasons.length;
    }

    const meta = await loadConsignMeta(kv);
    return res.json({
      complete: result.done,
      cacheComplete: result.complete,
      added: result.added,
      bucketed,
      versionByType: meta ? meta.versionByType : null,
      calls: lsFetch.callStats,
    });
  } catch (e) {
    console.error("[consign-cache] sync failed:", e.message);
    return res.status(503).json({ error: e.message });
  }
}
