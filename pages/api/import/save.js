// pages/api/import/save.js — Stores scraped datatail data in KV as override
// Chunks data to stay under KV 256KB per-value limit
import { getIronSession } from "iron-session";
import { kv } from "@vercel/kv";
import { bumpReportEpoch } from "../../../lib/scan-data-store";

const SESSION_OPTIONS = {
  cookieName: "flow_session",
  password: process.env.SESSION_SECRET,
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getIronSession(req, res, SESSION_OPTIONS);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season, data } = req.body || {};
  if (!season || !data) return res.status(400).json({ error: "season and data required" });

  // The datatail hard pull is a permanent historical baseline (RMH-era data that
  // never made it into LS). It is written WITHOUT a TTL so it does not silently
  // expire and regress the report; re-importing overwrites/merges in place.

  // Store store-level summary only when provided (non-empty)
  if (data.stores && Object.keys(data.stores).length > 0) {
    await kv.set(`scan:override:${season}:stores`, JSON.stringify(data.stores));
  }

  // Append to vendor index rather than overwrite
  const existingIndexRaw = await kv.get(`scan:override:${season}:vendorIndex`);
  const existingIndex = existingIndexRaw
    ? typeof existingIndexRaw === "string"
      ? JSON.parse(existingIndexRaw)
      : existingIndexRaw
    : [];
  const newKeys = Object.keys(data.vendors || {});
  const mergedIndex = Array.from(new Set([...existingIndex, ...newKeys]));
  await kv.set(`scan:override:${season}:vendorIndex`, JSON.stringify(mergedIndex));

  // Save each vendor individually
  const keys = Object.keys(data.vendors || {});
  const pipeline = kv.pipeline();
  for (const key of keys) {
    const vendorJson = JSON.stringify(data.vendors[key]);
    pipeline.set(`scan:override:${season}:v:${key}`, vendorJson);
  }
  await pipeline.exec();

  // The override just changed but scan:data.ts did not, so bump the report-cache
  // epoch to invalidate the precomputed summary/dept-row cache for this season.
  await bumpReportEpoch(kv, season);

  return res.json({ ok: true, season, vendorCount: keys.length });
}
