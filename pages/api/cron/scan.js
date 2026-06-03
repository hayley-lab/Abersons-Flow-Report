// Cron endpoint — advances or restarts scans for current seasons.
// Fires every 5 minutes via vercel.json cron schedule.
// Each invocation does one chunk of work per season.
// When a scan completes, it won't restart until RESCAN_INTERVAL_MS has passed.
import { kv } from "@vercel/kv";
import { SEASONS } from "../../../lib/seasons";

const RESCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between full rescans

// Current seasons = anything 2026 and later
function currentSeasons() {
  return SEASONS.filter(s => {
    const m = s.id.match(/\d+$/);
    return m && parseInt("20" + m[0].slice(-2)) >= 2026;
  }).map(s => s.id);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const base = `https://${process.env.VERCEL_URL}`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.CRON_SECRET}`,
  };

  const seasons = currentSeasons();
  const results = [];

  for (const season of seasons) {
    try {
      const [job, data] = await Promise.all([
        kv.get(`scan:job:${season}`),
        kv.get(`scan:data:${season}`),
      ]);

      const phase = job ? job.phase : null;
      const lastTs = data ? data.ts : null;
      const msSinceScan = lastTs ? Date.now() - lastTs : Infinity;

      let restart = "0";
      if (!phase || phase === "done" || phase === "error") {
        // Only restart if enough time has passed since last completed scan
        if (msSinceScan < RESCAN_INTERVAL_MS) {
          results.push({ season, action: "skipped", msSinceScan });
          continue;
        }
        restart = "1";
      }

      const r = await fetch(`${base}/api/scan/step?season=${encodeURIComponent(season)}&restart=${restart}`, {
        method: "POST",
        headers,
      });
      const json = await r.json();
      results.push({ season, action: restart === "1" ? "started" : "advanced", phase: json.phase, progress: json.progress });
    } catch (e) {
      results.push({ season, action: "error", error: e.message });
    }
  }

  return res.json({ ok: true, results });
}
