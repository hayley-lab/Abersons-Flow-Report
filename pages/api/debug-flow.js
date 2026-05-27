// pages/api/debug-flow.js  — tag filter diagnostic
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

const PREFALL26_ID = "83846ef9-8e32-4c5f-9817-03906e605784";
const KNOWN_PF26_SKU = "nx5ctp063/pf26"; // confirmed prefall26 parent product

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

  // Raw HTTP request that bypasses fetch URL encoding (preserves literal [] brackets)
  async function rawFetch(path) {
    const { request } = await import("node:https");
    const fullUrl = `${base}/${path}`;
    const url = new URL(fullUrl);
    // Split manually to preserve literal [] in query string
    const queryPart = fullUrl.includes("?") ? fullUrl.split("?")[1] : "";
    return new Promise((resolve) => {
      const req2 = request({
        hostname: url.hostname,
        path: url.pathname + (queryPart ? "?" + queryPart : ""),
        method: "GET",
        headers,
      }, (resp) => {
        let data = "";
        resp.on("data", (chunk) => { data += chunk; });
        resp.on("end", () => {
          try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: resp.statusCode, body: { raw: data.slice(0, 500) } }); }
        });
      });
      req2.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
      req2.end();
    });
  }

  // Q1: Find the known prefall26 product by SKU
  const skuSearch = await lsFetch(`2.0/products?sku=${encodeURIComponent(KNOWN_PF26_SKU)}&page_size=5`);
  const knownProduct = (skuSearch.body.data || [])[0] || null;
  const knownProductId = knownProduct ? knownProduct.id : null;

  // Q2: Fetch products with tag filter via normal fetch (may encode [] to %5B%5D)
  const normalFilter = await lsFetch(`2.0/products?tag_ids[]=${PREFALL26_ID}&page_size=200`);
  const normalItems = normalFilter.body.data || [];
  const normalContainsKnown = knownProductId ? normalItems.some(p => p.id === knownProductId) : null;

  // Q3: Fetch products with tag filter via raw HTTP (preserves literal [] brackets)
  const rawFilter = await rawFetch(`2.0/products?tag_ids[]=${PREFALL26_ID}&page_size=200`);
  const rawItems = rawFilter.body.data || [];
  const rawContainsKnown = knownProductId ? rawItems.some(p => p.id === knownProductId) : null;

  // Q4: Try encoded brackets explicitly
  const encodedFilter = await lsFetch(`2.0/products?tag_ids%5B%5D=${PREFALL26_ID}&page_size=200`);
  const encodedItems = encodedFilter.body.data || [];
  const encodedContainsKnown = knownProductId ? encodedItems.some(p => p.id === knownProductId) : null;

  // Q5: Fetch first 200 products with NO filter (for comparison)
  const noFilter = await lsFetch(`2.0/products?page_size=200`);
  const noFilterItems = noFilter.body.data || [];
  const noFilterContainsKnown = knownProductId ? noFilterItems.some(p => p.id === knownProductId) : null;

  return res.json({
    known_product: knownProduct ? { id: knownProductId, sku: knownProduct.sku, name: knownProduct.name, tag_ids: knownProduct.tag_ids } : "not found",

    // If filter works: count should be small (5-10), contains_known should be true
    // If filter broken: count = 200 (same as no-filter page), contains_known matches no-filter
    normal_fetch_filter: {
      note: "fetch() with ?tag_ids[]=UUID — brackets may be encoded to %5B%5D by WHATWG URL parser",
      count: normalItems.length,
      contains_known_product: normalContainsKnown,
      first_3_skus: normalItems.slice(0, 3).map(p => p.sku),
    },
    raw_http_filter: {
      note: "https.request() with ?tag_ids[]=UUID — bypasses URL encoding, sends literal brackets",
      count: rawItems.length,
      contains_known_product: rawContainsKnown,
      first_3_skus: rawItems.slice(0, 3).map(p => p.sku),
    },
    encoded_bracket_filter: {
      note: "fetch() with ?tag_ids%5B%5D=UUID — pre-encoded brackets",
      count: encodedItems.length,
      contains_known_product: encodedContainsKnown,
      first_3_skus: encodedItems.slice(0, 3).map(p => p.sku),
    },
    no_filter_baseline: {
      note: "No tag filter — first 200 products for comparison",
      count: noFilterItems.length,
      contains_known_product: noFilterContainsKnown,
      first_3_skus: noFilterItems.slice(0, 3).map(p => p.sku),
    },
  });
}
