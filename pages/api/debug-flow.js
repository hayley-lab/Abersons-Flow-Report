// pages/api/debug-flow.js  — targeted diagnostics for zero-match scan
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

  // ── Q1: Pagination sanity check ─────────────────────────────────────────────
  // Fetch page 1, use its version.max as cursor for page 2, check page 2 SKUs.
  // If page 2 has the SAME SKUs as page 1, the cursor is stuck and pagination
  // is looping — that would explain why 40k products are "scanned" but always
  // the same 200 products, finding 0 prefall26.
  const page1 = await lsFetch("2.0/products?page_size=200");
  const page1Items = page1.body.data || [];
  const page1Version = page1.body.version || null;
  const page1FirstSku = page1Items[0] ? page1Items[0].sku : null;
  const page1LastSku  = page1Items[page1Items.length - 1] ? page1Items[page1Items.length - 1].sku : null;

  let page2FirstSku = null, page2LastSku = null, page2Version = null, page2Count = 0;
  if (page1Version && page1Version.max) {
    const page2 = await lsFetch(`2.0/products?page_size=200&after=${page1Version.max}`);
    const page2Items = page2.body.data || [];
    page2Count    = page2Items.length;
    page2Version  = page2.body.version || null;
    page2FirstSku = page2Items[0] ? page2Items[0].sku : null;
    page2LastSku  = page2Items[page2Items.length - 1] ? page2Items[page2Items.length - 1].sku : null;
  }

  // Are page 1 and page 2 showing different products?
  const paginationAdvancing = page1FirstSku !== page2FirstSku;

  // ── Q2: What does a CONSIGNMENT line item's product look like in full? ──────
  // Fetch first consignment → first line item → product by ID.
  // This shows us ALL fields of a real PO product: is `sku` populated? Is it
  // a variant (variant_parent_id set)? What does the version field look like?
  const consResp  = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=3");
  const cons      = consResp.body.data || [];
  const poSamples = [];
  for (let ci = 0; ci < Math.min(cons.length, 3); ci++) {
    const itemsResp = await lsFetch(`2.0/consignments/${cons[ci].id}/products?page_size=3`);
    const lineItems = itemsResp.body.data || [];
    for (let li = 0; li < Math.min(lineItems.length, 2); li++) {
      const pid     = lineItems[li].product_id;
      const prodResp = await lsFetch(`2.0/products/${pid}`);
      // Single-product fetch may return {data: {...}} or just the object
      const prod = prodResp.body.data || prodResp.body || {};
      poSamples.push({
        po_id:             cons[ci].id,
        po_name:           cons[ci].name,
        product_id:        pid,
        // All key fields — is sku populated? Is it a variant?
        sku:               prod.sku,
        name:              prod.name,
        handle:            prod.handle,
        version:           prod.version,
        variant_parent_id: prod.variant_parent_id,
        product_type_id:   prod.product_type_id,
        supplier_id:       prod.supplier_id,
        price:             prod.price_excluding_tax,
        supply_price:      prod.supply_price,
        // Show all top-level keys so we can spot unexpected field names
        all_keys:          Object.keys(prod),
        consig_count:      lineItems[li].count,
        consig_received:   lineItems[li].received,
      });
    }
  }

  // ── Q3: Can we find a prefall26 product via variant_parent_id search? ────────
  // If we knew the parent ID of nx5ctp063/pf26, we could check if variants appear
  // in the product list. Instead, try fetching by name pattern if the API supports it.
  const nameSearch = await lsFetch("2.0/products?name=nx5ctp063%2Fpf26&page_size=5");
  const nameItems  = nameSearch.body.data || [];

  // ── Q4: Fetch a product KNOWN to be in the list (from page1) by ID ──────────
  // Check if the list response and single-product response have the same fields.
  // Specifically: does the list response include `sku`, `version`, etc.?
  const firstListProduct = page1Items[0] || null;
  let firstListProductById = null;
  if (firstListProduct) {
    const byId = await lsFetch(`2.0/products/${firstListProduct.id}`);
    firstListProductById = byId.body.data || byId.body || null;
  }

  return res.json({
    // ── Q1: Pagination ──────────────────────────────────────────────────────
    pagination_check: {
      note: "Are pages 1 and 2 different? If page1_first_sku === page2_first_sku, pagination is stuck in a loop.",
      page1_version_block: page1Version,
      page1_first_sku:     page1FirstSku,
      page1_last_sku:      page1LastSku,
      cursor_used_for_p2:  page1Version ? page1Version.max : null,
      page2_count:         page2Count,
      page2_version_block: page2Version,
      page2_first_sku:     page2FirstSku,
      page2_last_sku:      page2LastSku,
      pagination_is_advancing: paginationAdvancing,
    },

    // ── Q2: Consignment product structure ───────────────────────────────────
    consignment_product_samples: {
      note: "Products from PO line items fetched by ID. Check: is sku populated? Does it look like a season code?",
      samples: poSamples,
    },

    // ── Q3: Name search ─────────────────────────────────────────────────────
    name_search_pf26: {
      note: "Search by product name = 'nx5ctp063/pf26'. LS may not support ?name= filter.",
      status: nameSearch.status,
      count:  nameItems.length,
      first:  nameItems[0] ? { sku: nameItems[0].sku, name: nameItems[0].name, id: nameItems[0].id } : null,
    },

    // ── Q4: List vs single-fetch field comparison ──────────────────────────
    list_vs_by_id_comparison: {
      note: "First product from page1: compare fields from list response vs. fetching by ID.",
      in_list_response: firstListProduct ? {
        sku:               firstListProduct.sku,
        name:              firstListProduct.name,
        version:           firstListProduct.version,
        variant_parent_id: firstListProduct.variant_parent_id,
        all_keys:          Object.keys(firstListProduct),
      } : null,
      by_id_response: firstListProductById ? {
        sku:               firstListProductById.sku,
        name:              firstListProductById.name,
        version:           firstListProductById.version,
        variant_parent_id: firstListProductById.variant_parent_id,
        all_keys:          Object.keys(firstListProductById),
      } : null,
    },
  });
}
