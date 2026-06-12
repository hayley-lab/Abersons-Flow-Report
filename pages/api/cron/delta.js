// Delta cron — runs quick sales-only refresh for active seasons.
// Skips seasons that don't have a completed base scan yet.
import { kv } from "@vercel/kv";
import { SEASONS } from "../../../lib/seasons";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

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

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${process.env.VERCEL_URL}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.CRON_SECRET}`,
  };

  const seasons = currentSeasons();

  // One shared budget for the whole cron run (mirrors cron/scan's 230s loop
  // deadline, well under the 300s maxDuration). Each cache chunk is ~45s, so we
  // only START a chunk when it can finish inside the remaining budget; the
  // parallel per-season fan-out below (projection-only, fast) then runs in
  // whatever budget is left.
  const overallDeadline = Date.now() + 230 * 1000;
  const CACHE_CHUNK_MS = 45000;

  // Advance the store-wide sales cache ONCE up front (sequentially), so the
  // per-season deltas below — which run in parallel — only PROJECT from the
  // shared aggregate and never race each other advancing the same store keys.
  // The store is version-incremental so each run pages only the handful of new
  // sales.
  if (process.env.ENABLE_SALES_STORE !== "0") {
    while (Date.now() + CACHE_CHUNK_MS < overallDeadline) {
      try {
        const r = await fetch(`${base}/api/scan/sales-cache`, { method: "POST", headers });
        const body = await r.json().catch(() => null);
        if (!r.ok || body?.cacheComplete) break;
      } catch (e) {
        console.error("[cron/delta] sales drive failed:", e.message);
        break;
      }
    }
  }

  // Advance the store-wide INVENTORY cache ONCE up front too, for the same
  // reason: the per-season deltas below only READ this shared cache. Driving it
  // here (sequentially, version-incremental) avoids every season re-pulling the
  // full 2.0/inventory stream in parallel — the thundering herd that previously
  // rate-limited LS and timed the per-season delta function out.
  if (process.env.ENABLE_BULK_INVENTORY !== "0") {
    while (Date.now() + CACHE_CHUNK_MS < overallDeadline) {
      try {
        const r = await fetch(`${base}/api/scan/inventory-cache`, { method: "POST", headers });
        const body = await r.json().catch(() => null);
        if (!r.ok || body?.cacheComplete) break;
      } catch (e) {
        console.error("[cron/delta] inventory drive failed:", e.message);
        break;
      }
    }
  }

  // Check job states in parallel, then fire all delta scans in parallel
  const jobs = await Promise.all(seasons.map((s) => kv.get(`scan:job:${s}`)));

  const results = await Promise.all(
    seasons.map(async (season, i) => {
      const job = jobs[i];
      if (job && job.phase && job.phase !== "done" && job.phase !== "error") {
        return { season, action: "skipped", reason: "full scan in progress" };
      }
      try {
        const r = await fetch(`${base}/api/scan/delta?season=${encodeURIComponent(season)}`, {
          method: "POST",
          headers,
        });
        const json = await r.json();
        return r.ok
          ? { season, action: "delta", ts: json.ts, pages: json.pages }
          : { season, action: "skipped", reason: json.error };
      } catch (e) {
        return { season, action: "error", error: e.message };
      }
    })
  );

  return res.json({ ok: true, results });
}
