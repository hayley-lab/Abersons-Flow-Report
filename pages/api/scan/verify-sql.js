import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { SEASONS } from "../../../lib/seasons";
import { verifySqlSeason } from "../../../lib/report-verify";

export default async function handler(req, res) {
  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const session = cronAuth ? { authed: true } : await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const seasonParam = req.query.season;
  const seasons =
    seasonParam && seasonParam !== "all"
      ? String(seasonParam)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : SEASONS.map((s) => s.id);

  const results = [];
  for (const season of seasons) {
    try {
      results.push(await verifySqlSeason(kv, season));
    } catch (e) {
      results.push({ season, ok: false, error: e.message });
    }
  }

  const ok = results.every((result) => result.ok);
  return res.status(ok ? 200 : 500).json({ ok, results });
}
