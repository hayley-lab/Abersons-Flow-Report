// pages/api/import/save.js — Stores scraped datatail data in KV as override
// Chunks data to stay under KV 256KB per-value limit
import { getIronSession } from "iron-session";
import { kv } from "@vercel/kv";

const SESSION_OPTIONS = {
  cookieName: "flow_session",
  password: process.env.SESSION_SECRET,
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
};

const TTL = 60 * 60 * 24 * 30; // 30 days

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getIronSession(req, res, SESSION_OPTIONS);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season, data } = req.body || {};
  if (!season || !data) return res.status(400).json({ error: "season and data required" });

  const TTL_OPTS = { ex: TTL };

  // Store store-level summary only when provided (non-empty)
  if (data.stores && Object.keys(data.stores).length > 0) {
    await kv.set(`scan:override:${season}:stores`, JSON.stringify(data.stores), TTL_OPTS);
  }

  // Append to vendor index rather than overwrite
  const existingIndexRaw = await kv.get(`scan:override:${season}:vendorIndex`);
  const existingIndex = existingIndexRaw
    ? (typeof existingIndexRaw === "string" ? JSON.parse(existingIndexRaw) : existingIndexRaw)
    : [];
  const newKeys = Object.keys(data.vendors || {});
  const mergedIndex = Array.from(new Set([...existingIndex, ...newKeys]));
  await kv.set(`scan:override:${season}:vendorIndex`, JSON.stringify(mergedIndex), TTL_OPTS);

  // Save each vendor individually
  const pipeline = kv.pipeline();
  for (const key of vendorKeys) {
    const vendorJson = JSON.stringify(data.vendors[key]);
    pipeline.set(`scan:override:${season}:v:${key}`, vendorJson, TTL_OPTS);
  }
  await pipeline.exec();

  return res.json({ ok: true, season, vendorCount: vendorKeys.length });
}
