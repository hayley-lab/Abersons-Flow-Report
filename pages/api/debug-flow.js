// pages/api/debug-flow.js — temporary diagnostic endpoint, remove after debugging
export default async function handler(req, res) {
  const accessToken = process.env.LS_ACCESS_TOKEN;
  const domainPrefix = process.env.LS_DOMAIN_PREFIX;

  if (!accessToken || !domainPrefix) {
    return res.status(500).json({ error: "Lightspeed credentials not configured" });
  }

  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: { raw: text.slice(0, 300) } }; }
  }

  const FALL26  = "d58d14aa-939e-4a16-a8cf-ce36e5aeb1c3";
  const FALL25  = "45bc201b-3bf6-4fd7-bfea-c4ddf67c0d24";

  try {
    // Test every plausible filter parameter name for tags/categories
    const [a, b, c, d, e, f] = await Promise.all([
      lsFetch(`2.0/products?tag_id=${FALL26}&page_size=3`),
      lsFetch(`2.0/products?tag_ids[]=${FALL26}&page_size=3`),
      lsFetch(`2.0/products?category_id=${FALL26}&page_size=3`),
      lsFetch(`2.0/products?tag_id=${FALL25}&page_size=3`),
      lsFetch(`2.0/products?page_size=3`),              // unfiltered — what does data look like?
      lsFetch(`2.0/products?page_size=1`),              // get 1 product to inspect its fields
    ]);

    // Inspect the first unfiltered product's full structure
    const sampleProduct = f.body?.data?.[0];

    res.status(200).json({
      // HTTP status + count for each filter attempt
      fall26_tag_id:         { status: a.status, count: a.body?.data?.length ?? null, data_null: a.body?.data === null, errors: a.body?.errors },
      fall26_tag_ids_array:  { status: b.status, count: b.body?.data?.length ?? null, data_null: b.body?.data === null, errors: b.body?.errors },
      fall26_category_id:    { status: c.status, count: c.body?.data?.length ?? null, data_null: c.body?.data === null, errors: c.body?.errors },
      fall25_tag_id:         { status: d.status, count: d.body?.data?.length ?? null, data_null: d.body?.data === null, errors: d.body?.errors },
      unfiltered_3:          { status: e.status, count: e.body?.data?.length ?? null },

      // Full structure of one unfiltered product — shows us what keys exist
      sample_product_keys:   sampleProduct ? Object.keys(sampleProduct) : null,
      sample_product_tag_ids: sampleProduct?.tag_ids,
      sample_product_categories: sampleProduct?.categories,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
