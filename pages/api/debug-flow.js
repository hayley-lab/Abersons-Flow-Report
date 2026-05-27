// pages/api/debug-flow.js  — product structure + pagination diagnostic
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

const KNOWN_PF26_SKU = "nx5ctp063/pf26"; // confirmed prefall26 product

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

  // Q1: Fetch the first 3 products from the LIST endpoint (no filter)
  //     Shows us what fields are actually returned in a list response,
  //     especially whether `sku` is populated.
  const listPage1 = await lsFetch("2.0/products?page_size=3");
  const listItems = listPage1.body.data || [];
  const listVersionBlock = listPage1.body.version || null;

  // Q2: Test pagination — use the version cursor from Q1 to fetch page 2.
  //     If page 2 returns nothing or the cursor is 0/null, pagination is broken.
  let page2Items = [];
  let page2Cursor = null;
  if (listVersionBlock && listVersionBlock.max) {
    const page2 = await lsFetch(`2.0/products?page_size=3&after=${listVersionBlock.max}`);
    page2Items  = page2.body.data || [];
    page2Cursor = (page2.body.version && page2.body.version.max) || null;
  }

  // Q3: Fetch the known prefall26 product by exact SKU.
  //     Compare its structure/fields to the list response in Q1.
  const skuSearch = await lsFetch(`2.0/products?sku=${encodeURIComponent(KNOWN_PF26_SKU)}&page_size=3`);
  const knownProduct = (skuSearch.body.data || [])[0] || null;

  // Q4: If we found the known product, fetch it directly by ID.
  //     This often returns more complete field data than list endpoints.
  let productById = null;
  if (knownProduct) {
    const byId = await lsFetch(`2.0/products/${knownProduct.id}`);
    productById = byId.body.data || byId.body || null;
  }

  // Q5: Check if the known product appears in the first 200 products from the list.
  //     If not, it means either: (a) it's a variant excluded from the list,
  //     or (b) pagination stopped before reaching it.
  const bigList = await lsFetch("2.0/products?page_size=200");
  const bigListItems = bigList.body.data || [];
  const bigListVersion = bigList.body.version || null;
  const knownInBigList = knownProduct
    ? bigListItems.some(p => p.id === knownProduct.id)
    : null;
  const bigListSkus = bigListItems.map(p => p.sku).filter(Boolean).slice(0, 10);

  // Helper: extract safe summary of a product (avoids response bloat)
  function productSummary(p) {
    if (!p) return null;
    return {
      id:                p.id,
      name:              p.name,
      sku:               p.sku,
      handle:            p.handle,
      type:              p.type,
      variant_parent_id: p.variant_parent_id,
      product_type_id:   p.product_type_id,
      supplier_id:       p.supplier_id,
      price_excluding_tax: p.price_excluding_tax,
      supply_price:      p.supply_price,
      version:           p.version,
      tag_ids:           p.tag_ids,
      // Show ALL top-level keys so we can spot any unexpected field names
      all_keys:          Object.keys(p),
    };
  }

  return res.json({
    // ── Q1: List structure ──────────────────────────────────────────────────
    list_page1: {
      note: "First 3 products from 2.0/products (no filter). Check 'sku' field and 'version'.",
      version_block: listVersionBlock,
      items: listItems.map(productSummary),
    },

    // ── Q2: Pagination ──────────────────────────────────────────────────────
    pagination_test: {
      note: "Page 2 using version cursor from page 1. If page2_count=0 or cursor_used=null, pagination is broken.",
      cursor_used: (listVersionBlock && listVersionBlock.max) || null,
      page2_count: page2Items.length,
      page2_first_sku: page2Items[0] ? page2Items[0].sku : null,
      page2_version_block: page2Cursor,
    },

    // ── Q3: Known product by SKU ────────────────────────────────────────────
    known_product_by_sku: {
      note: "Product found by ?sku=nx5ctp063/pf26. Compare its fields to list_page1 items.",
      found: !!knownProduct,
      summary: productSummary(knownProduct),
    },

    // ── Q4: Product fetched by ID ───────────────────────────────────────────
    known_product_by_id: {
      note: "Same product fetched via 2.0/products/ID. May have more fields than list response.",
      summary: productSummary(productById),
    },

    // ── Q5: Is the known product in the first 200? ──────────────────────────
    known_in_first_200: {
      note: "True = product appears in 2.0/products?page_size=200. False = either a variant or pagination issue.",
      known_product_id: knownProduct ? knownProduct.id : null,
      found_in_first_200: knownInBigList,
      first_200_count: bigListItems.length,
      version_block: bigListVersion,
      first_10_skus_in_list: bigListSkus,
    },
  });
}
