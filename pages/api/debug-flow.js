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

  const TARGET_SKU = "nx5ctp063/pf26";
  const PREFALL26_TAG = "prefall26";

  try {
    // 1. Find the prefall26 tag ID
    const tagsRes = await lsFetch("2.0/tags?page_size=200");
    const allTags = tagsRes.body?.data ?? [];
    const prefall26Tag = allTags.find(t => t.name === PREFALL26_TAG);
    const fall26Tag    = allTags.find(t => t.name === "fall26");

    // 2. Search for the product by SKU
    const skuEncoded = encodeURIComponent(TARGET_SKU);
    const skuRes  = await lsFetch(`2.0/products?sku=${skuEncoded}`);
    const skuRes2 = await lsFetch(`2.0/products?filter[sku]=${skuEncoded}`);

    const skuProds  = skuRes.body?.data  ?? [];
    const skuProds2 = skuRes2.body?.data ?? [];
    const found = skuProds.length > 0 ? skuProds : skuProds2;

    // 3. If found, fetch full detail and its variants
    let productDetail = null;
    let variants = [];
    if (found.length > 0) {
      const p = found[0];
      // Fetch directly by ID for full detail
      const detailRes = await lsFetch(`2.0/products/${p.id}`);
      const detail = detailRes.body?.data ?? detailRes.body;
      productDetail = {
        id:               detail?.id,
        name:             detail?.name,
        sku:              detail?.sku,
        tag_ids:          detail?.tag_ids,
        has_variants:     detail?.has_variants,
        variant_parent_id: detail?.variant_parent_id,
        source:           detail?.source,
        supplier_id:      detail?.supplier_id,
        product_type_id:  detail?.product_type_id,
        has_prefall26_tag: prefall26Tag ? detail?.tag_ids?.includes(prefall26Tag.id) : "tag not found",
      };

      // Fetch variants of this product
      const varRes = await lsFetch(`2.0/products?variant_parent_id=${p.id}&page_size=10`);
      variants = (varRes.body?.data ?? []).map(v => ({
        id: v.id, name: v.name, sku: v.sku,
        tag_ids: v.tag_ids,
        variant_parent_id: v.variant_parent_id,
      }));
    }

    res.status(200).json({
      prefall26_tag:  prefall26Tag  ? { id: prefall26Tag.id,  name: prefall26Tag.name  } : "NOT FOUND",
      fall26_tag:     fall26Tag     ? { id: fall26Tag.id,     name: fall26Tag.name     } : "NOT FOUND",
      sku_search_v1:  { status: skuRes.status,  count: skuProds.length  },
      sku_search_v2:  { status: skuRes2.status, count: skuProds2.length },
      product_found:  found.length > 0,
      product_detail: productDetail,
      variants:       variants,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
