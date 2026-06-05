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

  const [data, big] = await Promise.all([
    kv.get(`scan:data:${season}`),
    kv.get(`scan:job:big:${season}`),
  ]);

  // Find vendor in deptVendors (final computed data)
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

  // If vendor given, show products from final scan data for that vendor
  let vendorProducts = null;
  if (vendor && data && data.deptVendors) {
    const allProds = [];
    Object.values(data.deptVendors).forEach(vendors => {
      (vendors || []).forEach(v => {
        if ((v.name || "").toLowerCase().includes(vendor.toLowerCase())) {
          (v.products || []).forEach(p => allProds.push(p));
        }
      });
    });
    allProds.sort((a, b) => (b.sold || 0) - (a.sold || 0));
    vendorProducts = allProds;
  }

  // If SKU given, find product via skuToPid in big state, then fetch LS sale lines
  let skuSales = null;
  if (sku || pidQuery) {
    try {
      const token   = await getLsToken();
      const base    = lsBase();
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      let pid = pidQuery || null;

      // Find PID from skuToPid map in big state
      if (!pid && sku && big && big.skuToPid) {
        const skuLower = sku.toLowerCase().trim();
        // Exact match first
        pid = big.skuToPid[skuLower];
        // Partial match fallback
        if (!pid) {
          for (const [k, v] of Object.entries(big.skuToPid)) {
            if (k.includes(skuLower) || skuLower.includes(k)) { pid = v; break; }
          }
        }
      }

      if (pid) {
        const stats = big && big.productStats ? (big.productStats[pid] || {}) : {};

        // Fetch LS product details and recent sales
        const [prodRes, salesRes] = await Promise.all([
          fetch(`${base}/2.0/products/${pid}`, { headers }),
          fetch(`${base}/2.0/sales?page_size=200&date_from=2025-11-01`, { headers }),
        ]);
        const [prodData, salesData] = await Promise.all([prodRes.json(), salesRes.json()]);
        const prod = prodData.data || prodData;

        const matchingLines = [];
        for (const sale of (salesData.data || [])) {
          for (const li of (sale.line_items || [])) {
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
          price: prod.price_excluding_tax,
          kvStats: stats,
          matchingLines,
        };
      } else {
        // Show skuToPid sample so user can identify the right key
        const sample = big && big.skuToPid
          ? Object.keys(big.skuToPid).filter(k => k.includes((sku||"").split("/")[0].toLowerCase())).slice(0, 20)
          : [];
        const allSample = big && big.skuToPid ? Object.keys(big.skuToPid).slice(0, 30) : [];
        skuSales = { error: "pid not found for sku", sku, pidQuery, matchingSkuKeys: sample, allSkuSample: allSample };
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
