// Cron endpoint — advances scans for all active seasons.
// Scheduled to fire hourly via vercel.json crons.
//
// Behavior differs by caller:
//   Vercel cron scheduler (CRON_SECRET header, no ?force) — loops internally
//     for its full time budget, advancing all seasons as many steps as possible.
//     This lets one cron invocation complete an entire scan rather than one step per firing.
//   UI "Sync from LS" button (?force=1, session auth) — one pass per call so the
//     browser loop can show live progress between calls.
import { kv } from "@vercel/kv";
import { SEASONS } from "../../../lib/seasons";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

const RESCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between full rescans
// Leave buffer before maxDuration so we can return cleanly.
// maxDuration is 300s (capped at 60s on Hobby plan).
const CRON_LOOP_DEADLINE_MS = 240 * 1000;

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

  const force = req.query.force === "1";
  const restartAll = req.query.restart === "1";
  // Loop internally only when called by the Vercel cron scheduler (not the UI).
  // UI calls use ?force=1 and need quick per-call responses for progress display.
  const loopInternally = cronAuth && !force;

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${process.env.VERCEL_URL}`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.CRON_SECRET}`,
  };

  const seasons = currentSeasons();

  let kvResults;
  try {
    kvResults = await Promise.all(
      seasons.map(season => Promise.all([
        kv.get(`scan:job:${season}`),
        force ? Promise.resolve(null) : kv.get(`scan:data:${season}`),
      ]))
    );
  } catch (e) {
    console.error("[cron/scan] KV read failed:", e.message);
    return res.status(503).json({ error: "KV read failed: " + e.message });
  }

  const CONCURRENCY = 3;

  // Build per-season work items
  const seasonState = seasons.map((season, i) => {
    const [job, data] = kvResults[i];
    const phase = job ? job.phase : null;
    const lastTs = (job && job.ts) || (data && data.ts) || null;
    const msSinceScan = lastTs ? Date.now() - lastTs : Infinity;

    let restart = "0";
    if (restartAll) {
      restart = "1";
    } else if (!phase || phase === "done" || phase === "error") {
      if (!force && msSinceScan < RESCAN_INTERVAL_MS) {
        return { season, phase, restart, done: true, action: "skipped" };
      }
      restart = "1";
    }

    return { season, phase, restart, done: false, action: null };
  });

  async function stepSeason(ss) {
    try {
      const r = await fetch(
        `${base}/api/scan/step?season=${encodeURIComponent(ss.season)}&restart=${ss.restart}`,
        { method: "POST", headers }
      );
      const json = await r.json();
      ss.restart = "0";
      ss.phase   = json.phase;
      if (json.phase === "done" || json.phase === "error") ss.done = true;
      ss.action  = "advanced";
      return { season: ss.season, action: ss.action, phase: json.phase, progress: json.progress };
    } catch (e) {
      ss.done   = true;
      ss.action = "error";
      return { season: ss.season, action: "error", error: e.message };
    }
  }

  if (loopInternally) {
    // Cron path: loop for full time budget, advancing all seasons repeatedly
    const loopStart = Date.now();
    while (Date.now() - loopStart < CRON_LOOP_DEADLINE_MS) {
      const pending = seasonState.filter(s => !s.done);
      if (pending.length === 0) break;

      const batch = pending.slice(0, CONCURRENCY);
      const batchResults = await Promise.all(batch.map(stepSeason));

      // Round-robin: move just-processed seasons to back so others get turns
      batch.forEach(ss => {
        if (!ss.done) {
          const idx = seasonState.indexOf(ss);
          seasonState.splice(idx, 1);
          seasonState.push(ss);
        }
      });

      console.log("[cron/scan] pass:", batchResults.map(r => `${r.season}=${r.phase || r.error}`).join(" "));
    }

    const allDone = seasonState.every(s => s.done);
    console.log(`[cron/scan] finished in ${Math.round((Date.now() - loopStart) / 1000)}s, allDone=${allDone}`);
    return res.json({
      ok: true,
      allDone,
      results: seasonState.map(s => ({ season: s.season, action: s.action || "skipped", phase: s.phase })),
    });

  } else {
    // UI path: one pass, return quickly so the browser loop can show progress
    const results = [];
    for (let i = 0; i < seasonState.length; i += CONCURRENCY) {
      const batch = seasonState.slice(i, i + CONCURRENCY).filter(s => !s.done);
      const batchResults = await Promise.all(batch.map(stepSeason));
      results.push(...batchResults);
    }
    // Include skipped seasons in results
    seasonState.filter(s => s.done && s.action === "skipped").forEach(s =>
      results.push({ season: s.season, action: "skipped" })
    );
    return res.json({ ok: true, results });
  }
}
