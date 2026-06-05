// Debug: read raw scan data from KV for a season and show specific vendor/product stats
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season, vendor, sku } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const [data, big] = await Promise.all([
    kv.get(`scan:data:${season}`),
    kv.get(`scan:job:big:${season}`),
  ]);

  // Find vendor in deptVendors
  const vendorMatches = [];
  if (data && data.deptVendors) {
    Object.entries(data.deptVendors).forEach(([deptId, vendors]) => {
      (vendors || []).forEach(v => {
        if (!vendor || (v.name || "").toLowerCase().includes(vendor.toLowerCase())) {
          vendorMatches.push({ deptId, id: v.id, name: v.name, ordered: v.ordered, received: v.received, sold: v.sold, returned: v.returned });
        }
      });
    });
  }

  // Find product stats by SKU
  const skuMatches = [];
  if (sku && big && big.pidToSupplier) {
    const skuToPid = big.skuToPid || {};
    Object.entries(skuToPid).forEach(([skuKey, pid]) => {
      if (skuKey.includes(sku.toLowerCase())) {
        const stats = (big.productStats || {})[pid] || {};
        skuMatches.push({ sku: skuKey, pid, sold: stats.sold, onSale: stats.onSale, returned: stats.returned });
      }
    });
  }

  return res.json({
    season,
    scanTs: data ? new Date(data.ts).toISOString() : null,
    vendorMatches,
    skuMatches,
  });
}
