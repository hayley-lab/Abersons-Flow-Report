// pages/api/import/debug.js — Dumps override KV structure for debugging
import { getIronSession } from "iron-session";
import { kv } from "@vercel/kv";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const [storesRaw, indexRaw] = await Promise.all([
    kv.get(`scan:override:${season}:stores`),
    kv.get(`scan:override:${season}:vendorIndex`),
  ]);

  const scanData = await kv.get(`scan:data:${season}`);

  const index = indexRaw ? (typeof indexRaw === "string" ? JSON.parse(indexRaw) : indexRaw) : null;
  const stores = storesRaw
    ? typeof storesRaw === "string"
      ? JSON.parse(storesRaw)
      : storesRaw
    : null;

  // Sample first vendor
  let sampleVendor = null;
  if (index && index.length > 0) {
    const v = await kv.get(`scan:override:${season}:v:${index[0]}`);
    sampleVendor = { key: index[0], value: typeof v === "string" ? JSON.parse(v) : v };
  }

  const scanSummary = scanData
    ? {
        summaryRowCount: (scanData.summaryRows || []).length,
        deptVendorKeys: Object.keys(scanData.deptVendors || {}),
        firstSummaryRow: (scanData.summaryRows || [])[0] || null,
      }
    : null;

  return res.json({
    season,
    storesCount: stores ? Object.keys(stores).length : 0,
    storesSample: stores ? Object.values(stores).slice(0, 3) : null,
    vendorIndexCount: index ? index.length : 0,
    vendorIndexSample: index ? index.slice(0, 3) : null,
    sampleVendor,
    scanSummary,
  });
}
