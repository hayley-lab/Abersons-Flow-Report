// Cron endpoint — advances or restarts scans for current seasons.
// Fires every 5 minutes via vercel.json cron schedule.
// Each invocation does one chunk of work per season.
// When a scan completes, it won't restart until RESCAN_INTERVAL_MS has passed.
import { kv } from "@vercel/kv";
import { SEASONS } from "../../../lib/seasons";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

const RESCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between full rescans

// Active seasons = current year, next year, and previous year (still selling prior-year merchandise)
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

  // Accept cron secret OR logged-in session (so the UI can trigger all-seasons scan)
  const cronAuth = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuth) {
    const session = await getIronSession(req, res, sessionOptions);
    if (!session.authed) return res.status(401).json({ error: "Unauthorized" });
  }

  // When called from the UI with ?force=1, ignore the rescan interval so a
  // manual full sync always starts fresh regardless of last scan time.
  const force = req.query.force === "1";
  // ?restart=1 forces a clean restart of ALL seasons including in-progress ones.
  // The UI passes this only on the first call of a scan loop, not subsequent iterations.
  const restartAll = req.query.restart === "1";

  // VERCEL_URL is deployment-specific and can return 404/HTML for the production alias.
  // VERCEL_PROJECT_PRODUCTION_URL is the stable production domain (no protocol prefix).
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${process.env.VERCEL_URL}`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.CRON_SECRET}`,
  };

  const seasons = currentSeasons();

  // Load all KV state in parallel first — wrap in try/catch so a transient
  // KV error returns a 503 instead of an unhandled 500.
  let kvResults;
  try {
    kvResults = await Promise.all(
      seasons.map(season => Promise.all([
        kv.get(`scan:job:${season}`),
        kv.get(`scan:data:${season}`),
      ]))
    );
  } catch (e) {
    console.error("[cron/scan] KV read failed:", e.message);
    return res.status(503).json({ error: "KV read failed: " + e.message });
  }

  // Process seasons with limited concurrency to avoid LS API rate limits.
  // 3 at a time balances speed vs. not hammering the LS API with 8+ parallel requests.
  const CONCURRENCY = 3;
  const tasks = seasons.map((season, i) => async () => {
    const [job, data] = kvResults[i];
    const phase = job ? job.phase : null;
    const lastTs = data ? data.ts : null;
    const msSinceScan = lastTs ? Date.now() - lastTs : Infinity;

    let restart = "0";
    if (restartAll) {
      // First call of a manual sync: restart every season clean regardless of phase.
      restart = "1";
    } else if (!phase || phase === "done" || phase === "error") {
      if (!force && msSinceScan < RESCAN_INTERVAL_MS) {
        return { season, action: "skipped", msSinceScan };
      }
      restart = "1";
    }

    try {
      const r = await fetch(`${base}/api/scan/step?season=${encodeURIComponent(season)}&restart=${restart}`, {
        method: "POST",
        headers,
      });
      const json = await r.json();
      return { season, action: restart === "1" ? "started" : "advanced", phase: json.phase, progress: json.progress };
    } catch (e) {
      return { season, action: "error", error: e.message };
    }
  });

  const results = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = await Promise.all(tasks.slice(i, i + CONCURRENCY).map(t => t()));
    results.push(...batch);
  }

  return res.json({ ok: true, results });
}
