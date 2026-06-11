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

  // Advance the store-wide sales cache ONCE up front (sequentially), so the
  // per-season deltas below — which run in parallel — only PROJECT from the
  // shared aggregate and never race each other advancing the same store keys.
  // Bounded so the delta cron stays well under its maxDuration; the store is
  // version-incremental so each run pages only the handful of new sales.
  if (process.env.ENABLE_SALES_STORE !== "0") {
    const salesDeadline = Date.now() + 120 * 1000;
    do {
      try {
        const r = await fetch(`${base}/api/scan/sales-cache`, { method: "POST", headers });
        const body = await r.json().catch(() => null);
        if (!r.ok || body?.cacheComplete) break;
      } catch (e) {
        console.error("[cron/delta] sales drive failed:", e.message);
        break;
      }
    } while (Date.now() < salesDeadline);
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
