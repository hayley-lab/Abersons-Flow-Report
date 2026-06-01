// Temporary diagnostic: summarise what's actually stored in KV for a season.
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const data = await kv.get(`scan:data:${season}`);
  if (!data) return res.json({ error: "No scan data in KV for this season" });

  const { pidToSupplier, pidToType, seasonPids, deptVendors } = data;

  const total = seasonPids ? seasonPids.length : 0;
  const noSupplier = seasonPids ? seasonPids.filter(id => {
    const s = pidToSupplier && pidToSupplier[id];
    return !s || (s.i || s.id) === "__none__";
  }).length : 0;
  const noType = seasonPids ? seasonPids.filter(id => {
    const t = pidToType && pidToType[id];
    return !t || t === "__none__";
  }).length : 0;

  // Sample 5 products with real supplier IDs
  const withSupplier = seasonPids ? seasonPids.filter(id => {
    const s = pidToSupplier && pidToSupplier[id];
    return s && (s.i || s.id) !== "__none__";
  }).slice(0, 5).map(id => ({
    id,
    sup: pidToSupplier[id],
    typ: pidToType && pidToType[id],
  })) : [];

  const deptVendorSummary = deptVendors
    ? Object.entries(deptVendors).map(([deptId, vendors]) => ({
        deptId,
        vendorCount: vendors.length,
        vendorIds: vendors.map(v => v.id).slice(0, 3),
      }))
    : [];

  return res.json({
    ts: data.ts,
    season: data.season,
    totalSkus: total,
    noSupplier,
    noType,
    sampleWithSupplier: withSupplier,
    deptVendorSummary,
  });
}
