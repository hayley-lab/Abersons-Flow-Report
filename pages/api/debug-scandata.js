// Debug: read raw scan data from KV for a season and show specific vendor/product stats
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../lib/ls-auth";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season, vendor, sku, pid: pidQuery } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  // scan:data has: ts, summaryRows, deptVendors, productStats, seasonPids, pidToType, pidToSupplier, pidToQtyOrdered, skuToPid
  const data = await kv.get(`scan:data:${season}`);

  // Find vendor in deptVendors
  const vendorMatches = [];
  if (data && data.deptVendors) {
    Object.entries(data.deptVendors).forEach(([deptId, vendors]) => {
      (vendors || []).forEach((v) => {
        if (!vendor || (v.name || "").toLowerCase().includes(vendor.toLowerCase())) {
          vendorMatches.push({
            deptId,
            id: v.id,
            name: v.name,
            ordered: v.ordered,
            received: v.received,
            sold: v.sold,
            returned: v.returned,
          });
        }
      });
    });
  }

  // If vendor given, find all products for that vendor via pidToSupplier
  let vendorProducts = null;
  if (vendor && data && data.pidToSupplier && data.productStats) {
    const matchingVendorIds = new Set(vendorMatches.map((v) => String(v.id)));
    // Build inverted skuToPid so we can show SKU per pid
    const pidToSku = {};
    if (data.skuToPid) {
      Object.entries(data.skuToPid).forEach(([s, p]) => {
        pidToSku[p] = s;
      });
    }
    const products = [];
    Object.entries(data.pidToSupplier).forEach(([pid, sup]) => {
      if (sup && matchingVendorIds.has(String(sup.i))) {
        const stats = data.productStats[pid] || {};
        products.push({
          pid,
          sku: pidToSku[pid] || "",
          sold: stats.sold || 0,
          onSale: stats.onSale || 0,
          returned: stats.returned || 0,
        });
      }
    });
    products.sort((a, b) => b.sold - a.sold);
    vendorProducts = products;
  }

  // If SKU given, look up via skuToPid then fetch LS sale lines
  let skuSales = null;
  if (sku || pidQuery) {
    try {
      const token = await getLsToken();
      const base = lsBase();
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      let pid = pidQuery || null;

      if (!pid && sku && data && data.skuToPid) {
        const skuLower = sku.toLowerCase().trim();
        pid = data.skuToPid[skuLower];
        if (!pid) {
          for (const [k, v] of Object.entries(data.skuToPid)) {
            if (k.includes(skuLower) || skuLower.includes(k)) {
              pid = v;
              break;
            }
          }
        }
      }

      if (pid) {
        const stats = data && data.productStats ? data.productStats[pid] || {} : {};

        const [prodRes, salesRes] = await Promise.all([
          fetch(`${base}/2.0/products/${pid}`, { headers }),
          fetch(`${base}/2.0/sales?page_size=200&date_from=2025-11-01`, { headers }),
        ]);
        const [prodData, salesData] = await Promise.all([prodRes.json(), salesRes.json()]);
        const prod = prodData.data || prodData;

        const matchingLines = [];
        for (const sale of salesData.data || []) {
          for (const li of sale.line_items || []) {
            if (li.product_id === pid) {
              matchingLines.push({
                sale_id: sale.id,
                sale_date: sale.completed_at || sale.created_at,
                qty: li.quantity,
                price: li.price,
                total_price: li.total_price,
                discount: li.discount,
                discount_total: li.discount_total,
                is_return: li.is_return,
              });
            }
          }
        }
        skuSales = {
          pid,
          name: prod.name,
          custom_sku: prod.custom_sku,
          sku: prod.sku,
          kvStats: stats,
          matchingLines,
        };
      } else {
        const skuKeys = data && data.skuToPid ? Object.keys(data.skuToPid) : [];
        const base = (sku || "").split("/")[0].toLowerCase();
        const matching = skuKeys.filter((k) => k.includes(base));
        skuSales = {
          error: "pid not found",
          sku,
          pidQuery,
          totalSkuKeys: skuKeys.length,
          matchingSkuKeys: matching.slice(0, 20),
        };
      }
    } catch (e) {
      skuSales = { error: e.message };
    }
  }

  return res.json({
    season,
    scanTs: data ? new Date(data.ts).toISOString() : null,
    vendorMatches,
    vendorProducts,
    skuSales,
  });
}
