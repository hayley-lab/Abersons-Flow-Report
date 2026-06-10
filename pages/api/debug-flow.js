// pages/api/debug-flow.js  — name-search and version diagnostic
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
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: { raw: text.slice(0, 500) } };
    }
  }

  function summarise(p) {
    if (!p) return null;
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      version: p.version,
      variant_parent_id: p.variant_parent_id,
      product_type_id: p.product_type_id,
      supplier_id: p.supplier_id,
      price: p.price_excluding_tax,
      supply_price: p.supply_price,
    };
  }

  // ── Q1: Get the known pf26 product by ID (get its version + variant_parent_id) ─
  const pf26ById = await lsFetch("2.0/products/9a20b2ba-ba0b-4adb-a7e7-a8a10c1ce4d1");
  const pf26Product = pf26ById.body.data || pf26ById.body || {};
  const pf26Version = pf26Product.version || null;

  // ── Q2: Does the general product list include the pf26 product? ─────────────
  // Fetch the page that would contain pf26's version and check if it's there.
  // We'll search around its version using after=(version-1).
  let pf26InList = false;
  let pageAroundPf26 = [];
  if (pf26Version) {
    const resp = await lsFetch(`2.0/products?page_size=200&after=${pf26Version - 1}`);
    const items = resp.body.data || [];
    pageAroundPf26 = items.slice(0, 5).map(summarise);
    pf26InList = items.some((p) => p.id === pf26Product.id);
  }

  // ── Q3: Is ?name= a CONTAINS filter? ────────────────────────────────────────
  // If ?name=/pf26 returns many results, it's doing a contains search.
  // This would let us find ALL prefall26 products without a full catalog scan.
  const nameSlash = await lsFetch("2.0/products?name=%2Fpf26&page_size=10"); // ?name=/pf26
  const namePlain = await lsFetch("2.0/products?name=pf26&page_size=10"); // ?name=pf26
  const nameExact = await lsFetch("2.0/products?name=nx5ctp063%2Fpf26&page_size=10"); // exact product name

  // ── Q4: Does ?search= work for partial SKU/name matching? ────────────────────
  const searchPf26 = await lsFetch("2.0/products?search=pf26&page_size=10");
  const searchSlash = await lsFetch("2.0/products?search=%2Fpf26&page_size=10");

  // ── Q5: What page is pf26 on relative to the full product list? ─────────────
  // We know page1 max version = 50021080855, page2 max = 50021087386.
  // If pf26Version > page2 max, it's on page 3+.
  const page1Max = 50021080855;
  const page2Max = 50021087386;
  const versionsPerPage = 200;
  const avgVersionStep = (page2Max - page1Max) / versionsPerPage; // ~32 per item
  let estimatedPage = null;
  if (pf26Version) {
    if (pf26Version <= page1Max) estimatedPage = "page 1 (first 200 products)";
    else if (pf26Version <= page2Max) estimatedPage = "page 2 (products 201-400)";
    else {
      const pagesAfter2 = Math.ceil((pf26Version - page2Max) / (avgVersionStep * versionsPerPage));
      estimatedPage = `page ~${2 + pagesAfter2} (approx ${(2 + pagesAfter2) * 200} products in)`;
    }
  }

  return res.json({
    // ── Q1: pf26 product details ─────────────────────────────────────────────
    pf26_product_by_id: {
      note: "Known pf26 product fetched by ID. variant_parent_id tells us if it's a parent or variant.",
      sku: pf26Product.sku,
      name: pf26Product.name,
      version: pf26Version,
      variant_parent_id: pf26Product.variant_parent_id,
      product_type_id: pf26Product.product_type_id,
      supplier_id: pf26Product.supplier_id,
      price: pf26Product.price_excluding_tax,
      supply_price: pf26Product.supply_price,
    },

    // ── Q2: Does it appear in the general list? ──────────────────────────────
    pf26_in_general_list: {
      note: "Fetched the page that should contain pf26's version. Is it actually there?",
      pf26_version: pf26Version,
      estimated_page: estimatedPage,
      found_in_list: pf26InList,
      first_5_on_that_page: pageAroundPf26,
    },

    // ── Q3: Name filter behavior ──────────────────────────────────────────────
    name_filter_tests: {
      note: "Testing whether ?name= does contains vs exact matching.",
      "name=/pf26": {
        status: nameSlash.status,
        count: (nameSlash.body.data || []).length,
        first_sku: (nameSlash.body.data || [])[0] ? (nameSlash.body.data || [])[0].sku : null,
      },
      "name=pf26": {
        status: namePlain.status,
        count: (namePlain.body.data || []).length,
        first_sku: (namePlain.body.data || [])[0] ? (namePlain.body.data || [])[0].sku : null,
      },
      "name=nx5ctp063/pf26": {
        status: nameExact.status,
        count: (nameExact.body.data || []).length,
        first_sku: (nameExact.body.data || [])[0] ? (nameExact.body.data || [])[0].sku : null,
      },
    },

    // ── Q4: Search parameter ──────────────────────────────────────────────────
    search_filter_tests: {
      note: "Testing ?search= for full-text product search.",
      "search=pf26": {
        status: searchPf26.status,
        count: (searchPf26.body.data || []).length,
        first_sku: (searchPf26.body.data || [])[0] ? (searchPf26.body.data || [])[0].sku : null,
      },
      "search=/pf26": {
        status: searchSlash.status,
        count: (searchSlash.body.data || []).length,
        first_sku: (searchSlash.body.data || [])[0] ? (searchSlash.body.data || [])[0].sku : null,
      },
    },
  });
}
