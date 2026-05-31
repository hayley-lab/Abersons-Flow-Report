// Returns pre-computed scan data from KV for the requested season.
// Also returns job progress if a scan is currently running.
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const [data, job] = await Promise.all([
    kv.get(`scan:data:${season}`),
    kv.get(`scan:job:${season}`),
  ]);

  return res.json({
    data: data || null,
    job:  job  ? { phase: job.phase, progress: job.progress, error: job.error } : null,
  });
}
