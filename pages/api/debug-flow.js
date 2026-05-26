// pages/api/debug-flow.js — product + tag structure inspection
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
    catch { return { status: r.status, body: { raw: text.slice(0, 500) } }; }
  }

  try {
    // 1. Get all tags — find season tags
    const tagsRes = await lsFetch("2.0/tags?page_size=50");
    const allTags = tagsRes.body?.data ?? [];
    const seasonTags = allTags.filter(t =>
      /^(pre)?(spring|fall)\d{2}$/i.test(t.name)
    );

    // 2. Get one product — show ALL fields so we can see exact structure
    const prodRes = await lsFetch("2.0/products?page_size=1");
    const sampleProduct = prodRes.body?.data?.[0] ?? null;

    // 3. If we found a season tag, fetch a product WITH that tag to compare
    let taggedProduct = null;
    if (seasonTags.length > 0) {
      const tagId = seasonTags[0].id;
      const taggedRes = await lsFetch(`2.0/products?tag_id=${tagId}&page_size=1`);
      taggedProduct = taggedRes.body?.data?.[0] ?? taggedRes.body ?? null;
    }

    // 4. Get product categories (the correct endpoint, not product_types)
    const catsRes = await lsFetch("2.0/product-categories?page_size=50");
    const catsSample = catsRes.body?.data?.slice(0, 5) ?? catsRes.body ?? null;

    // 5. Get suppliers
    const suppRes = await lsFetch("2.0/suppliers?page_size=10");
    const suppSample = suppRes.body?.data?.slice(0, 5) ?? suppRes.body ?? null;

    res.status(200).json({
      tags: {
        total_found: allTags.length,
        season_tags: seasonTags,
      },
      product: {
        status: prodRes.status,
        all_fields: sampleProduct ? Object.keys(sampleProduct) : null,
        sample: sampleProduct,
      },
      tagged_product: {
        note: "Product fetched using tag_id filter — check if this works",
        sample: taggedProduct,
      },
      categories: {
        status: catsRes.status,
        sample: catsSample,
      },
      suppliers: {
        status: suppRes.status,
        sample: suppSample,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
