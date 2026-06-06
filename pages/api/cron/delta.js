// Delta cron — runs quick sales-only refresh for active seasons.
// Skips seasons that don't have a completed base scan yet.
import { kv } from "@vercel/kv";
import { SEASONS } from "../../../lib/seasons";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

function currentSeasons() {
  const year = new Date().getFullYear();
  return SEASONS.filter(s => {
    const m = s.id.match(/\d+$/);
    if (!m) return false;
    const y = parseInt("20" + m[0].slice(-2));
    return y >= year - 1;
  }).map(s => s.id);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  const cronAuth = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuth) {
    const session = await getIronSession(req, res, sessionOptions);
    if (!session.authed) return res.status(401).json({ error: "Unauthorized" });
  }

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${process.env.VERCEL_URL}`;
  const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.CRON_SECRET}` };

  const seasons = currentSeasons();
  const results = [];

  for (const season of seasons) {
    // Skip if a full scan is currently in progress
    const job = await kv.get(`scan:job:${season}`);
    if (job && job.phase && job.phase !== "done" && job.phase !== "error") {
      results.push({ season, action: "skipped", reason: "full scan in progress" });
      continue;
    }

    try {
      const r = await fetch(`${base}/api/scan/delta?season=${encodeURIComponent(season)}`, {
        method: "POST", headers,
      });
      const json = await r.json();
      if (r.ok) {
        results.push({ season, action: "delta", ts: json.ts, pages: json.pages });
      } else {
        results.push({ season, action: "skipped", reason: json.error });
      }
    } catch (e) {
      results.push({ season, action: "error", error: e.message });
    }
  }

  return res.json({ ok: true, results });
}
