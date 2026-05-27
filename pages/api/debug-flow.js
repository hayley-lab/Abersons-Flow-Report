import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

const PREFALL26_ID = "83846ef9-8e32-4c5f-9817-03906e605784";
const KNOWN_PF26_SKU = "nx5ctp063/pf26";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.accessToken || !session.domainPrefix) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const base = `https://${session.domainPrefix}.retail.lightspeed.app/api`;
  const headers = { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" };

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: { raw: text.slice(0, 300) } }; }
  }

  async function rawFetch(path) {
    const { request } = await import("node:https");
    const fullUrl = `${base}/${path}`;
    const url = new URL(fullUrl);
    const queryPart = fullUrl.includes("?") ? fullUrl.split("?")[1] : "";
    return new Promise((resolve) => {
      const req2 = request({ hostname: url.hostname, path: url.pathname + (queryPart ? "?" + queryPart : ""), method: "GET", headers }, (resp) => {
        let data = "";
        resp.on("data", (chunk) => { data += chunk; });
        resp.on("end", () => {
          try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: resp.statusCode, body: { raw: data.slice(0, 300) } }); }
        });
      });
      req2.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
      req2.end();
    });
  }

  const Q1 = await lsFetch(`2.0/products?sku=${encodeURIComponent(KNOWN_PF26_SKU)}&page_size=5`);
  const knownProduct = (Q1.body.data || [])[0] || null;
  const knownId = knownProduct ? knownProduct.id : null;

  const Q2 = await lsFetch(`2.0/products?page_size=5`);
  const Q3 = await lsFetch(`2.0/products?tag_ids[]=${PREFALL26_ID}&page_size=200`);
  const Q4 = await rawFetch(`2.0/products?tag_ids[]=${PREFALL26_ID}&page_size=200`);

  const q3Items = Q3.body.data || [];
  const q4Items = Q4.body.data || [];

  return res.json({
    known_product_sku_search: { status: Q1.status, found: !!knownProduct, sku: knownProduct?.sku, id: knownId },
    no_filter_baseline:       { status: Q2.status, count: (Q2.body.data || []).length, first_sku: (Q2.body.data || [])[0]?.sku },
    normal_fetch_tag_filter:  { status: Q3.status, count: q3Items.length, first_3_skus: q3Items.slice(0,3).map(p=>p.sku), contains_known: knownId ? q3Items.some(p=>p.id===knownId) : null },
    raw_http_tag_filter:      { status: Q4.status, count: q4Items.length, first_3_skus: q4Items.slice(0,3).map(p=>p.sku), contains_known: knownId ? q4Items.some(p=>p.id===knownId) : null },
  });
}
