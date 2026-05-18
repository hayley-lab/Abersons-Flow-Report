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
    return r.json();
  }

  try {
    // 1. List all tags in the system
    const tagsResp = await lsFetch("2.0/tags?page_size=200");

    // 2. Try fetching products filtered by a tag (using the first tag as a test)
    const firstTag = tagsResp?.data?.[0];
    let productsByTag = null;
    if (firstTag?.id) {
      productsByTag = await lsFetch(`2.0/products?tag_id=${firstTag.id}&page_size=3`);
    }

    // 3. Also try the "categories" endpoint (tags and categories are the same in LS)
    const categoriesResp = await lsFetch("2.0/categories?page_size=200");

    res.status(200).json({
      tags: tagsResp?.data || tagsResp,
      tags_error: tagsResp?.error || null,
      first_tag: firstTag,
      products_by_first_tag_count: productsByTag?.data?.length,
      products_by_first_tag_sample: productsByTag?.data?.[0] ? {
        id: productsByTag.data[0].id,
        name: productsByTag.data[0].name,
        tag_ids: productsByTag.data[0].tag_ids,
        product_type_id: productsByTag.data[0].product_type_id,
      } : null,
      categories: categoriesResp?.data || categoriesResp,
      categories_error: categoriesResp?.error || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
