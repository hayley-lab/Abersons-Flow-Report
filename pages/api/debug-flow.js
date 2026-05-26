// pages/api/debug-flow.js
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.accessToken) return res.status(401).json({ error: "Not authenticated" });

  const domainPrefix = process.env.LS_DOMAIN_PREFIX;
  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const headers = { Authorization: `Bearer ${session.accessToken}`, Accept: "application/json" };

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: { raw: text.slice(0, 300) } }; }
  }

  // IDs confirmed from previous debug runs
  const PREFALL26_ID  = "83846ef9-8e32-4c5f-9817-03906e605784";
  const KNOWN_USER_PRODUCT_ID = "2affc501-9d8e-4c1d-97a4-e16530120bfb"; // "heart" pendant, source:USER

  try {
    // Q1: Does fetching ONE product DIRECTLY by ID return populated tag_ids?
    const directRes = await lsFetch(`2.0/products/${KNOWN_USER_PRODUCT_ID}`);
    const directProd = directRes.body?.data ?? directRes.body;

    // Q2: Does a product_tags join-table endpoint exist?
    const pt1 = await lsFetch(`2.0/product_tags?page_size=5`);
    const pt2 = await lsFetch(`2.0/product_tags?tag_id=${PREFALL26_ID}&page_size=5`);

    // Q3: Can we filter products by tag_id?
    const tf1 = await lsFetch(`2.0/products?tag_id=${PREFALL26_ID}&page_size=5`);
    const tf2 = await lsFetch(`2.0/products?tag_ids[]=${PREFALL26_ID}&page_size=5`);

    // Q4: Does a tags/{id}/products endpoint exist?
    const tagProds = await lsFetch(`2.0/tags/${PREFALL26_ID}/products?page_size=5`);

    res.status(200).json({
      Q1_direct_product_fetch: {
        id:      directProd?.id,
        name:    directProd?.name,
        tag_ids: directProd?.tag_ids,
        all_keys: Object.keys(directProd ?? {}),
      },
      Q2_product_tags_no_filter: { status: pt1.status, count: (pt1.body?.data ?? []).length, sample: (pt1.body?.data ?? []).slice(0,2) },
      Q2_product_tags_by_tag:    { status: pt2.status, count: (pt2.body?.data ?? []).length, sample: (pt2.body?.data ?? []).slice(0,2) },
      Q3_products_tag_id_param:  { status: tf1.status, count: (tf1.body?.data ?? []).length },
      Q3_products_tag_ids_array: { status: tf2.status, count: (tf2.body?.data ?? []).length },
      Q4_tags_slash_products:    { status: tagProds.status, body: tagProds.body },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
