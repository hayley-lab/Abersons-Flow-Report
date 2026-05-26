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
    catch { return { status: r.status, body: { raw: text.slice(0, 500) } }; }
  }

  try {
    // 1. Find prefall26 tag
    const tagsRes = await lsFetch("2.0/tags?page_size=200");
    const allTags = tagsRes.body?.data ?? [];
    const prefall26Tag = allTags.find(t => t.name === "prefall26");

    // 2. Search for the known SKU — try both filter styles
    const skuA = await lsFetch("2.0/products?sku=nx5ctp063%2Fpf26");
    const skuB = await lsFetch("2.0/products?filter%5Bsku%5D=nx5ctp063%2Fpf26");
    const foundProds = (skuA.body?.data ?? []).concat(skuB.body?.data ?? []);
    const foundProd  = foundProds[0] ?? null;

    // 3. If found, fetch it DIRECTLY by ID (single-product endpoint often returns more fields)
    let directFetch = null;
    let variantParentDirect = null;
    if (foundProd?.id) {
      const dr = await lsFetch(`2.0/products/${foundProd.id}`);
      const d  = dr.body?.data ?? dr.body;
      directFetch = { id: d?.id, name: d?.name, sku: d?.sku, tag_ids: d?.tag_ids, variant_parent_id: d?.variant_parent_id, source: d?.source, all_keys: Object.keys(d || {}) };

      if (d?.variant_parent_id) {
        const pr = await lsFetch(`2.0/products/${d.variant_parent_id}`);
        const p  = pr.body?.data ?? pr.body;
        variantParentDirect = { id: p?.id, name: p?.name, sku: p?.sku, tag_ids: p?.tag_ids, has_prefall26: prefall26Tag ? p?.tag_ids?.includes(prefall26Tag.id) : null };
      }
    }

    // 4. Try product_tags endpoint (LS join table between products and tags)
    const ptA = await lsFetch("2.0/product_tags?page_size=5");
    const ptB = await lsFetch("2.0/product-tags?page_size=5");

    // 5. Try fetching products FOR this specific tag
    const tagProdsA = prefall26Tag ? await lsFetch(`2.0/products?tag_id=${prefall26Tag.id}&page_size=5`) : null;
    const tagProdsB = prefall26Tag ? await lsFetch(`2.0/tags/${prefall26Tag.id}/products?page_size=5`) : null;

    res.status(200).json({
      prefall26_tag: prefall26Tag ?? "NOT FOUND",
      sku_search:    { skuA_count: (skuA.body?.data ?? []).length, skuA_status: skuA.status, skuB_count: (skuB.body?.data ?? []).length },
      product_direct_by_id:        directFetch,
      variant_parent_direct_by_id: variantParentDirect,
      product_tags_endpoint_A:     { status: ptA.status, body_keys: Object.keys(ptA.body ?? {}), count: (ptA.body?.data ?? []).length },
      product_tags_endpoint_B:     { status: ptB.status, body_keys: Object.keys(ptB.body ?? {}), count: (ptB.body?.data ?? []).length },
      filter_by_tag_id:            { status: tagProdsA?.status, count: (tagProdsA?.body?.data ?? []).length },
      tag_slash_products:          { status: tagProdsB?.status, body: tagProdsB?.body },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
