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
    // Replicate EXACTLY what the app does — count products, check mapping

    // 1. Fetch all product types
    const typesResp = await lsFetch("2.0/product_types?page_size=200");
    const cats = typesResp?.data || [];
    const map = {};
    cats.forEach(c => { map[c.id] = c.name; });

    // 2. Fetch ALL products with deleted=true (up to 100 pages like the app now does)
    const pidTocat = {};
    let after = null;
    let pages = 0;
    let withType = 0;
    let withoutType = 0;
    while (pages < 100) {
      pages++;
      const url = `2.0/products?deleted=true&page_size=200${after ? "&after=" + after : ""}`;
      const resp = await lsFetch(url);
      const items = resp?.data || [];
      items.forEach(p => {
        if (p.product_type_id) {
          pidTocat[p.id] = p.product_type_id;
          withType++;
        } else {
          withoutType++;
        }
      });
      if (items.length < 200) break;
      if (resp?.version?.max) { after = resp.version.max; continue; }
      break;
    }

    // 3. Check specific known product
    const knownProductId = "2cd9304b-d70e-4ece-933f-38b027c10e83"; // astellatrq/s26
    const knownProductTypeId = pidTocat[knownProductId];

    // 4. Check a sample consignment product mapping
    const consigProductsResp = await lsFetch("2.0/consignments/a8e5719d-06ad-11f1-bb87-feec027b79b9/products?page_size=5");
    const consigProducts = consigProductsResp?.data || [];
    const consigMapping = consigProducts.map(item => ({
      product_id: item.product_id,
      mapped_type_id: pidTocat[item.product_id] || null,
      mapped_type_name: map[pidTocat[item.product_id]] || "NOT FOUND",
      cost: item.cost,
      count: item.count,
    }));

    res.status(200).json({
      product_types_count: cats.length,
      product_types: cats.map(c => ({ id: c.id, name: c.name })),
      total_pages_fetched: pages,
      total_products_fetched: withType + withoutType,
      products_with_type: withType,
      products_without_type: withoutType,
      known_product_in_map: !!pidTocat[knownProductId],
      known_product_type_id: knownProductTypeId || null,
      known_product_type_name: map[knownProductTypeId] || "NOT FOUND",
      consig_mapping_sample: consigMapping,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
