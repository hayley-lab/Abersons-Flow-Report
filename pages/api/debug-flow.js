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
    // Get all consignments (up to 200)
    const consignmentsResp = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=200");
    const allConsignments = consignmentsResp?.data || [];

    // Summarise each consignment
    const consignmentSummary = allConsignments.map(c => ({
      id: c.id,
      reference: c.reference,
      supplier_id: c.supplier_id,
      status: c.status,
      consignment_date: c.consignment_date,
    }));

    // Find first consignment with a real supplier_id
    const realConsig = allConsignments.find(c => c.supplier_id != null) || allConsignments[1];

    // Get products for that consignment
    let realConsigProducts = null;
    if (realConsig) {
      realConsigProducts = await lsFetch(`2.0/consignments/${realConsig.id}/products?page_size=5`);
    }

    // Look up the first product from that consignment
    let realProduct = null;
    const firstRealConsigProduct = realConsigProducts?.data?.[0];
    if (firstRealConsigProduct?.product_id) {
      const r = await lsFetch(`2.0/products/${firstRealConsigProduct.product_id}?deleted=true`);
      const p = r?.data || r;
      realProduct = {
        id: p?.id,
        name: p?.name,
        source: p?.source,
        product_type_id: p?.product_type_id,
        type: p?.type,
        deleted_at: p?.deleted_at,
        supplier_id: p?.supplier_id,
        brand_id: p?.brand_id,
      };
    }

    // Count total products across all pages
    let totalProducts = 0;
    let after = null;
    let pages = 0;
    while (pages < 30) {
      pages++;
      const url = `2.0/products?deleted=true&page_size=200${after ? "&after=" + after : ""}`;
      const resp = await lsFetch(url);
      const items = resp?.data || [];
      totalProducts += items.length;
      if (items.length < 200) break;
      if (resp?.version?.max) { after = resp.version.max; continue; }
      break;
    }

    res.status(200).json({
      total_consignments: allConsignments.length,
      consignment_summary: consignmentSummary,
      real_consig: realConsig ? { id: realConsig.id, reference: realConsig.reference, supplier_id: realConsig.supplier_id } : null,
      real_consig_product_sample: firstRealConsigProduct,
      real_product_lookup: realProduct,
      total_products_fetched: totalProducts,
      total_pages: pages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
