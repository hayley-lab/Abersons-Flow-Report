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
    // 1. Sample product types
    const types = await lsFetch("2.0/product_types?page_size=5");

    // 2. Sample products (active)
    const activeProducts = await lsFetch("2.0/products?page_size=3");

    // 3. Sample products (deleted=true)
    const deletedProducts = await lsFetch("2.0/products?deleted=true&page_size=3");

    // 4. Sample consignments
    const consignments = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=3");

    // 5. Products for first consignment (if any)
    let consigProducts = null;
    const firstConsig = consignments?.data?.[0];
    if (firstConsig) {
      consigProducts = await lsFetch(`2.0/consignments/${firstConsig.id}/products?page_size=3`);
    }

    res.status(200).json({
      product_types_sample: types?.data?.slice(0, 3),
      active_product_sample: activeProducts?.data?.[0],
      deleted_product_sample: deletedProducts?.data?.[0],
      deleted_product_keys: deletedProducts?.data?.[0] ? Object.keys(deletedProducts.data[0]) : [],
      consignment_sample: firstConsig,
      consignment_keys: firstConsig ? Object.keys(firstConsig) : [],
      consig_product_sample: consigProducts?.data?.[0],
      consig_product_keys: consigProducts?.data?.[0] ? Object.keys(consigProducts.data[0]) : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
