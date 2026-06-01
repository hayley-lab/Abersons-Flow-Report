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

  const { pidToSupplier, pidToType, seasonPids, deptVendors, summaryRows } = data;

  // Build dept name map
  const deptNames = {};
  (summaryRows || []).forEach(r => { deptNames[r.id] = r.name; });

  // Build full vendor list across all depts with names
  const allVendors = [];
  for (const [deptId, vendors] of Object.entries(deptVendors || {})) {
    for (const v of vendors) {
      allVendors.push({ deptId, deptName: deptNames[deptId] || deptId, vendorId: v.id, vendorName: v.name, ordered: v.ordered });
    }
  }

  // For each dept+vendor, count matching products using the same filter as the UI
  const vendorProductCounts = allVendors.map(({ deptId, deptName, vendorId, vendorName, ordered }) => {
    const matches = (seasonPids || []).filter(id => {
      const sup = pidToSupplier && pidToSupplier[id];
      const typ = pidToType && pidToType[id];
      return sup && (sup.i || sup.id) === vendorId && (typ === deptId || typ === "__none__");
    });
    return { deptName, vendorName, vendorId, deptId, ordered, matchingSkus: matches.length };
  }).sort((a, b) => b.ordered - a.ordered);

  return res.json({
    ts: data.ts,
    totalSkus: (seasonPids || []).length,
    vendorProductCounts: vendorProductCounts.slice(0, 30),
  });
}
