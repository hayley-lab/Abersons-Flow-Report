// pages/api/debug-flow.js — fetch all tags to see exact names
export default async function handler(req, res) {
  const accessToken = process.env.LS_ACCESS_TOKEN;
  const domainPrefix = process.env.LS_DOMAIN_PREFIX;

  if (!accessToken || !domainPrefix) {
    return res.status(500).json({ error: "Lightspeed credentials not configured" });
  }

  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  async function fetchAllPages(path) {
    const results = [];
    let url = `${base}/${path}`;
    let page = 1;
    while (url && page <= 20) {
      const r = await fetch(url, { headers });
      const json = await r.json();
      const items = json.data ?? [];
      results.push(...items);
      // LS pagination: check for next cursor or page
      const after = json.after ?? json.next ?? null;
      if (after && items.length > 0) {
        const sep = path.includes("?") ? "&" : "?";
        url = `${base}/${path}${sep}after=${after}&page_size=200`;
      } else {
        url = null;
      }
      page++;
    }
    return results;
  }

  try {
    // Get ALL tags
    const allTags = await fetchAllPages("2.0/tags?page_size=200");

    // Get one REAL product (skip system/discount ones)
    const prodRes = await fetch(`${base}/2.0/products?page_size=10&active=true`, { headers });
    const prodJson = await prodRes.json();
    const realProduct = prodJson.data?.find(p =>
      p.source !== "SYSTEM" && p.has_inventory !== false && p.supplier_id
    ) ?? prodJson.data?.[0] ?? null;

    res.status(200).json({
      all_tags: {
        total: allTags.length,
        names: allTags.map(t => ({ id: t.id, name: t.name })),
      },
      real_product: {
        name: realProduct?.name,
        supplier_id: realProduct?.supplier_id,
        product_category: realProduct?.product_category,
        categories: realProduct?.categories,
        tag_ids: realProduct?.tag_ids,
        price_excluding_tax: realProduct?.price_excluding_tax,
        supply_price: realProduct?.supply_price,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
