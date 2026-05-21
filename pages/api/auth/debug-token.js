// pages/api/auth/debug-token.js — find a confirmed prefall26 product and look for its sales
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  const { accessToken, domainPrefix } = session;
  if (!accessToken || !domainPrefix) return res.status(401).json({ error: "Not authenticated" });

  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const hdrs = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  async function ls(path) {
    const r = await fetch(`${base}/${path}`, { headers: hdrs });
    if (!r.ok) return { error: r.status, body: await r.text().then(t => t.slice(0, 200)) };
    return r.json();
  }

  // 1. Find prefall26 tag
  const tagsData = await ls("2.0/tags?page_size=200");
  const seasonTag = tagsData.data?.find((t) => t.name === "prefall26");
  if (!seasonTag) return res.status(200).json({ error: "prefall26 tag not found" });

  // 2. Scan consignments until we find a product that HAS the prefall26 tag
  let taggedProduct = null;
  const consigns = await ls("2.0/consignments?type=SUPPLIER&page_size=50");
  for (const c of consigns.data || []) {
    const liData = await ls(`2.0/consignments/${c.id}/products?page_size=20`);
    for (const li of liData.data || []) {
      const prod = await ls(`2.0/products/${li.product_id}`);
      const p = prod.data || prod;
      if (p?.tag_ids?.includes(seasonTag.id)) {
        taggedProduct = { id: p.id, name: p.name, tag_ids: p.tag_ids };
        break;
      }
    }
    if (taggedProduct) break;
  }

  if (!taggedProduct) {
    return res.status(200).json({
      season_tag: seasonTag,
      result: "No products with prefall26 tag found in first 50 consignments",
    });
  }

  // 3. Fetch 4 pages of sales (800 sales) and look for this product
  let foundInSale = null;
  let totalSalesChecked = 0;
  let after = null;
  for (let page = 0; page < 4; page++) {
    const url = "2.0/sales?page_size=200" + (after ? `&after=${after}` : "");
    const salesData = await ls(url);
    const sales = salesData.data || [];
    totalSalesChecked += sales.length;
    for (const sale of sales) {
      const match = (sale.line_items || []).find((li) => li.product_id === taggedProduct.id);
      if (match) {
        foundInSale = { sale_id: sale.id, sale_date: sale.sale_date, line_item: match };
        break;
      }
    }
    if (foundInSale || sales.length < 200) break;
    after = salesData.version?.max;
    if (!after) break;
  }

  // 4. Also report the date range of each page
  const page1 = await ls("2.0/sales?page_size=200");
  const p1Sales = page1.data || [];

  res.status(200).json({
    season_tag: { id: seasonTag.id, name: seasonTag.name },
    tagged_product_found: taggedProduct,
    sales_search: {
      total_sales_checked: totalSalesChecked,
      found_in_sale: foundInSale,
    },
    sales_page1_date_range: {
      first: p1Sales[0]?.sale_date,
      last: p1Sales[p1Sales.length - 1]?.sale_date,
      count: p1Sales.length,
    },
  });
}
