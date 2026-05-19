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
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
  }

  // Known tag IDs from previous debug
  const FALL26_TAG_ID  = "d58d14aa-939e-4a16-a8cf-ce36e5aeb1c3";
  const FALL25_TAG_ID  = "45bc201b-3bf6-4fd7-bfea-c4ddf67c0d24";
  const SPRING26_TAG_ID = "560ee43c-ee48-4808-9607-2eb4856ecbdc";

  try {
    // 1. Test tag_id filter with different parameter formats
    const [byTagId, byTagIdsArray, noFilter, fall25Test] = await Promise.all([
      lsFetch(`2.0/products?tag_id=${FALL26_TAG_ID}&page_size=5`),
      lsFetch(`2.0/products?tag_ids[]=${FALL26_TAG_ID}&page_size=5`),
      lsFetch(`2.0/products?page_size=1`),
      lsFetch(`2.0/products?tag_id=${FALL25_TAG_ID}&page_size=5`),
    ]);

    // 2. Check total product count (unfiltered)
    const totalCount = noFilter?.pagination?.total ?? noFilter?.data?.length ?? "unknown";

    // 3. Check what a product with fall26 tag looks like (find one directly)
    // Search for a product that has the fall26 tag via tag_ids on the product
    const fall26ProductSample = byTagId?.data?.[0] || byTagIdsArray?.data?.[0] || null;

    res.status(200).json({
      // How many products does each format return?
      tag_id_param_count:        byTagId?.data?.length ?? byTagId?.errors,
      tag_ids_array_param_count: byTagIdsArray?.data?.length ?? byTagIdsArray?.errors,
      fall25_tag_id_count:       fall25Test?.data?.length ?? fall25Test?.errors,

      // Sample from the working format (if any)
      fall26_product_sample: fall26ProductSample ? {
        id:              fall26ProductSample.id,
        name:            fall26ProductSample.name,
        tag_ids:         fall26ProductSample.tag_ids,
        product_type_id: fall26ProductSample.product_type_id,
      } : null,

      // Pagination on unfiltered vs filtered
      unfiltered_pagination: noFilter?.pagination,
      tag_id_pagination:     byTagId?.pagination,

      // Total product count in store
      total_products_in_store: totalCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
