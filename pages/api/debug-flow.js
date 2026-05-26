// pages/api/debug-flow.js — diagnose tag/variant/product matching via session
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.accessToken) return res.status(401).json({ error: "Not authenticated — visit /api/auth/lightspeed first" });

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
    // 1. Find fall26 tag and show its ID + type
    const tagsRes = await lsFetch("2.0/tags?page_size=200");
    const allTags = tagsRes.body?.data ?? [];
    const seasonTag = allTags.find(t => t.name === "fall26");

    // 2. Get first page of products, check their tag_ids field
    const prodsRes = await lsFetch("2.0/products?page_size=20");
    const allProds = prodsRes.body?.data ?? [];

    const withTags    = allProds.filter(p => p.tag_ids && p.tag_ids.length > 0).slice(0, 3);
    const withoutTags = allProds.filter(p => !p.tag_ids || p.tag_ids.length === 0).slice(0, 2);

    // 3. Type check: do tag IDs match?
    const sampleTagIds = withTags.length > 0 ? withTags[0].tag_ids : [];
    const typeCheck = {
      seasonTag_id:        seasonTag ? seasonTag.id : null,
      seasonTag_id_type:   seasonTag ? typeof seasonTag.id : "tag not found",
      sample_product_tag_ids:       sampleTagIds,
      sample_product_tag_ids_types: sampleTagIds.map(id => typeof id),
      includes_works:      seasonTag ? sampleTagIds.includes(seasonTag.id) : null,
      strict_eq_test:      seasonTag && sampleTagIds.length > 0 ? (sampleTagIds[0] === seasonTag.id) : null,
    };

    // 4. Count how many of the 20 products have the fall26 tag
    const matchCount = allProds.filter(p => p.tag_ids && seasonTag && p.tag_ids.includes(seasonTag.id)).length;
    const matchCountStr = allProds.filter(p => p.tag_ids && seasonTag && p.tag_ids.map(String).includes(String(seasonTag.id))).length;

    res.status(200).json({
      season_tag:          seasonTag ? { id: seasonTag.id, name: seasonTag.name } : null,
      type_check:          typeCheck,
      match_with_includes: matchCount,
      match_with_toString: matchCountStr,
      products_with_tags:  withTags.map(p => ({ id: p.id, name: p.name, tag_ids: p.tag_ids, variant_parent_id: p.variant_parent_id, has_variants: p.has_variants })),
      products_no_tags:    withoutTags.map(p => ({ id: p.id, name: p.name, tag_ids: p.tag_ids, variant_parent_id: p.variant_parent_id })),
      total_tags_in_store: allTags.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
