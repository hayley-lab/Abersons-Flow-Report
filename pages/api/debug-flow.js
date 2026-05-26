// pages/api/debug-flow.js — diagnose tag/variant/consignment product matching
export default async function handler(req, res) {
  const accessToken = process.env.LS_ACCESS_TOKEN;
  const domainPrefix = process.env.LS_DOMAIN_PREFIX;
  if (!accessToken || !domainPrefix) return res.status(500).json({ error: "Missing credentials" });

  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: { raw: text.slice(0, 300) } }; }
  }

  try {
    // 1. Find a season tag
    const tagsRes = await lsFetch("2.0/tags?page_size=200");
    const allTags = tagsRes.body?.data ?? [];
    const seasonTag = allTags.find(t => t.name === "fall26")
      ?? allTags.find(t => /^(pre)?(spring|fall)\d{2}$/.test(t.name));

    // 2. Get first consignment line item and look up its product directly
    const consigRes = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=1");
    const firstConsig = consigRes.body?.data?.[0];
    let lineItemProductId = null;
    let lineItemProduct = null;
    let parentProduct = null;

    if (firstConsig?.id) {
      const liRes = await lsFetch(`2.0/consignments/${firstConsig.id}/products?page_size=1`);
      const firstLI = liRes.body?.data?.[0];
      lineItemProductId = firstLI?.product_id ?? null;

      if (lineItemProductId) {
        // Look up this specific product
        const pRes = await lsFetch(`2.0/products/${lineItemProductId}`);
        const p = pRes.body?.data ?? pRes.body;
        lineItemProduct = {
          id: p?.id,
          name: p?.name,
          tag_ids: p?.tag_ids,
          has_variants: p?.has_variants,
          variant_parent_id: p?.variant_parent_id,
          supplier_id: p?.supplier_id,
          product_type_id: p?.product_type_id,
          has_season_tag: p?.tag_ids?.includes(seasonTag?.id),
        };

        // If it's a variant, look up its parent
        if (p?.variant_parent_id) {
          const parentRes = await lsFetch(`2.0/products/${p.variant_parent_id}`);
          const parent = parentRes.body?.data ?? parentRes.body;
          parentProduct = {
            id: parent?.id,
            name: parent?.name,
            tag_ids: parent?.tag_ids,
            has_season_tag: parent?.tag_ids?.includes(seasonTag?.id),
            variant_count: parent?.variant_count,
          };
        }
      }
    }

    // 3. Get first 3 non-system products and show their tags + variant info
    const prodsRes = await lsFetch("2.0/products?page_size=10");
    const sampleProds = (prodsRes.body?.data ?? [])
      .filter(p => p.source !== "SYSTEM")
      .slice(0, 3)
      .map(p => ({
        id: p.id,
        name: p.name,
        tag_ids: p.tag_ids,
        variant_parent_id: p.variant_parent_id,
        has_variants: p.has_variants,
        supplier_id: p.supplier_id,
        product_type_id: p.product_type_id,
      }));

    res.status(200).json({
      season_tag: seasonTag ? { id: seasonTag.id, name: seasonTag.name } : null,
      consignment_line_item_product: lineItemProduct,
      parent_product_if_variant: parentProduct,
      sample_products: sampleProds,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
