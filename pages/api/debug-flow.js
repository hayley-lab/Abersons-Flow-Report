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

  const FALL26_ID = "d58d14aa-939e-4a16-a8cf-ce36e5aeb1c3";

  try {
    // 1. Get a real consignment line item → look up that product directly
    const consigRes = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=1");
    const firstConsig = consigRes.body?.data?.[0];
    let consigProduct = null;
    let parentProduct = null;

    if (firstConsig?.id) {
      const liRes = await lsFetch(`2.0/consignments/${firstConsig.id}/products?page_size=1`);
      const firstLI = liRes.body?.data?.[0];

      if (firstLI?.product_id) {
        const pRes = await lsFetch(`2.0/products/${firstLI.product_id}`);
        const p = pRes.body?.data || pRes.body;
        consigProduct = {
          id: p?.id, name: p?.name,
          tag_ids: p?.tag_ids,
          has_fall26_tag: p?.tag_ids?.includes(FALL26_ID),
          variant_parent_id: p?.variant_parent_id,
          source: p?.source,
        };
        // If variant, check parent
        if (p?.variant_parent_id) {
          const parentRes = await lsFetch(`2.0/products/${p.variant_parent_id}`);
          const parent = parentRes.body?.data || parentRes.body;
          parentProduct = {
            id: parent?.id, name: parent?.name,
            tag_ids: parent?.tag_ids,
            has_fall26_tag: parent?.tag_ids?.includes(FALL26_ID),
          };
        }
      }
    }

    // 2. Scan first 200 products — count tagged ones
    const scanRes = await lsFetch("2.0/products?page_size=200");
    const scanProds = scanRes.body?.data || [];
    const withAnyTag   = scanProds.filter(p => p.tag_ids && p.tag_ids.length > 0);
    const withFall26   = scanProds.filter(p => p.tag_ids && p.tag_ids.includes(FALL26_ID));
    const nonSystem    = scanProds.filter(p => p.source !== "SYSTEM" && p.source !== "SAMPLE");

    res.status(200).json({
      fall26_tag_id:          FALL26_ID,
      consignment_line_item_product: consigProduct,
      parent_product_if_variant:     parentProduct,
      first_200_products: {
        total_returned:     scanProds.length,
        non_system_sample:  nonSystem.length,
        with_any_tag:       withAnyTag.length,
        with_fall26_tag:    withFall26.length,
        sample_with_tags:   withAnyTag.slice(0, 3).map(p => ({ id: p.id, name: p.name, tag_ids: p.tag_ids, source: p.source })),
        sample_non_system:  nonSystem.slice(0, 3).map(p => ({ id: p.id, name: p.name, tag_ids: p.tag_ids, source: p.source })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
