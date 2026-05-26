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
    const url = `${base}/${path}`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 800) }; }
    return { status: r.status, url, body };
  }

  try {
    const prodsRes  = await lsFetch("2.0/products?page_size=5");
    const tagsRes   = await lsFetch("2.0/tags?page_size=3");
    const consigRes = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=1");

    res.status(200).json({
      base_url:              base,
      products_http_status:  prodsRes.status,
      products_body_keys:    Object.keys(prodsRes.body || {}),
      products_data_count:   Array.isArray(prodsRes.body?.data) ? prodsRes.body.data.length : "not an array",
      products_raw_if_error: prodsRes.status !== 200 ? prodsRes.body : undefined,
      products_sample:       (prodsRes.body?.data || []).slice(0, 2).map(p => ({
        id: p.id, name: p.name, tag_ids: p.tag_ids,
        variant_parent_id: p.variant_parent_id, source: p.source,
      })),
      tags_http_status:      tagsRes.status,
      tags_sample:           (tagsRes.body?.data || []).slice(0, 3).map(t => ({ id: t.id, name: t.name })),
      consignments_status:   consigRes.status,
      consignments_count:    Array.isArray(consigRes.body?.data) ? consigRes.body.data.length : consigRes.body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
