// Debug: read raw scan data from KV for a season and show specific vendor/product stats
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../lib/ls-auth";
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

  // If SKU given, find product in LS and fetch its recent sale line items
  let skuSales = null;
  if (sku) {
    try {
      const token   = await getLsToken();
      const base    = lsBase();
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      // Search for the product by SKU - try both the full SKU and the part before "/"
      const skuBase = sku.split("/")[0];
      const searchRes = await fetch(`${base}/2.0/products?active=1&search=${encodeURIComponent(skuBase)}&page_size=50`, { headers });
      const searchData = await searchRes.json();
      const allProducts = searchData.data || [];
      const products = allProducts.filter(p => {
        const s = ((p.custom_sku || "") + " " + (p.sku || "")).toLowerCase();
        return s.includes(sku.toLowerCase()) || s.includes(skuBase.toLowerCase());
      });

      if (products.length > 0) {
        const pid = products[0].id;
        // Fetch recent sales containing this product
        const salesRes = await fetch(`${base}/2.0/sales?page_size=200&date_from=2025-11-01`, { headers });
        const salesData = await salesRes.json();
        const matchingLines = [];
        for (const sale of (salesData.data || [])) {
          for (const li of (sale.line_items || [])) {
            if (li.product_id === pid) {
              matchingLines.push({
                sale_id: sale.id,
                sale_status: sale.status,
                sale_date: sale.completed_at || sale.created_at,
                qty: li.quantity,
                price: li.price,
                unit_price: li.unit_price,
                total_price: li.total_price,
                discount: li.discount,
                discount_total: li.discount_total,
                is_return: li.is_return,
                status: li.status,
              });
            }
          }
        }
        skuSales = { pid, product_name: products[0].name, sku: products[0].custom_sku || products[0].sku, matchingLines, allMatches: products.map(p => ({ id: p.id, name: p.name, custom_sku: p.custom_sku, sku: p.sku })) };
      } else {
        skuSales = { error: "product not found", sku, skuBase, rawCount: allProducts.length, rawSample: allProducts.slice(0, 3).map(p => ({ id: p.id, name: p.name, custom_sku: p.custom_sku, sku: p.sku })) };
      }
    } catch (e) {
      skuSales = { error: e.message };
    }
  }

  return res.json({
    season,
    scanTs: data ? new Date(data.ts).toISOString() : null,
    vendorMatches,
    skuSales,
  });
}
