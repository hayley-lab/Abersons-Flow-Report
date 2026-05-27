// pages/api/debug-flow.js  — consignment product SKU diagnostic
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.accessToken || !session.domainPrefix) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const base = `https://${session.domainPrefix}.retail.lightspeed.app/api`;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
  };

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: { raw: text.slice(0, 500) } }; }
  }

  // Q1: Fetch the LAST page of products (newest = current season).
  //     We walk forward page by page using the version cursor until we reach the end.
  //     Capped at 250 pages to avoid timeout. Shows the final page's SKUs.
  let after = null;
  let lastSkus = [];
  let lastVersionBlock = null;
  let totalPages = 0;
  const MAX_PAGES = 250;
  while (totalPages < MAX_PAGES) {
    totalPages++;
    const path = "2.0/products?page_size=200" + (after ? "&after=" + after : "");
    const resp = await lsFetch(path);
    const items = resp.body.data || [];
    const vb = resp.body.version || null;
    if (items.length === 0) break;
    lastSkus = items.map(p => p.sku).filter(Boolean);
    lastVersionBlock = vb;
    if (items.length < 200) break; // last page
    if (!vb || !vb.max) break;    // no cursor
    after = vb.max;
  }

  // Q2: Fetch the 3 most-recently-modified consignments and sample their
  //     line items, then look up each product to see its actual SKU.
  //     This shows us what SKU format PO products actually use.
  const consResp = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=5");
  const consignments = consResp.body.data || [];
  const consignmentSamples = [];

  for (let ci = 0; ci < Math.min(consignments.length, 3); ci++) {
    const c = consignments[ci];
    const itemsResp = await lsFetch(`2.0/consignments/${c.id}/products?page_size=5`);
    const lineItems = itemsResp.body.data || [];
    const productDetails = [];
    for (let li = 0; li < Math.min(lineItems.length, 3); li++) {
      const pid = lineItems[li].product_id;
      const prodResp = await lsFetch(`2.0/products/${pid}`);
      const prod = prodResp.body.data || prodResp.body || {};
      productDetails.push({
        product_id: pid,
        sku:        prod.sku,
        name:       prod.name,
        count:      lineItems[li].count,
        received:   lineItems[li].received,
      });
    }
    consignmentSamples.push({
      id:       c.id,
      name:     c.name,
      status:   c.status,
      products: productDetails,
    });
  }

  // Q3: Try a few SKU search patterns to see what format prefall26 uses.
  //     Tests both /pf26 and /pf2026 variants.
  const skuTests = {};
  for (const testSku of ["pf26", "pf2026", "/pf26", "f26", "pf 26"]) {
    const r = await lsFetch(`2.0/products?sku=${encodeURIComponent(testSku)}&page_size=3`);
    skuTests[testSku] = {
      count: (r.body.data || []).length,
      first_sku: (r.body.data || [])[0] ? (r.body.data || [])[0].sku : null,
    };
  }

  return res.json({
    // ── Q1: Newest products ──────────────────────────────────────────────────
    newest_products: {
      note: "Last page of 2.0/products — these are the newest (current season) products. If prefall26 exists, their SKUs should appear here.",
      pages_traversed: totalPages,
      last_page_count: lastSkus.length,
      last_version_block: lastVersionBlock,
      last_page_skus: lastSkus.slice(0, 30), // first 30 SKUs from the final page
    },

    // ── Q2: Consignment product SKUs ─────────────────────────────────────────
    consignment_product_samples: {
      note: "First 3 consignments and their line-item product SKUs. Shows the actual SKU format used in purchase orders.",
      samples: consignmentSamples,
    },

    // ── Q3: SKU pattern search ───────────────────────────────────────────────
    sku_pattern_tests: {
      note: "Tests various prefall26 SKU patterns. LS ?sku= is exact match only, so these test specific strings.",
      results: skuTests,
    },
  });
}
