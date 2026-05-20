// pages/api/debug-flow.js — field inspection for consignment line items and sales
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
    // 1. Get first consignment
    const consigRes = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=1");
    const firstConsig = consigRes.body?.data?.[0];

    // 2. Get its line items
    let sampleLineItem = null;
    let lineItemsStatus = null;
    if (firstConsig?.id) {
      const liRes = await lsFetch(`2.0/consignments/${firstConsig.id}/products?page_size=1`);
      lineItemsStatus = liRes.status;
      sampleLineItem = liRes.body?.data?.[0] ?? null;
    }

    // 3. Get first sale and its line items
    const salesRes = await lsFetch("2.0/sales?page_size=1");
    const firstSale = salesRes.body?.data?.[0];
    const sampleSaleLineItem = firstSale?.line_items?.[0] ?? null;

    res.status(200).json({
      consignment: {
        status: consigRes.status,
        sample: firstConsig ? {
          id: firstConsig.id,
          status: firstConsig.status,
          all_keys: Object.keys(firstConsig),
        } : null,
      },
      consignment_line_item: {
        status: lineItemsStatus,
        // Show every field so we can see exact names for count/received/cost
        sample: sampleLineItem,
        all_keys: sampleLineItem ? Object.keys(sampleLineItem) : null,
      },
      sale: {
        status: salesRes.status,
        sample: firstSale ? {
          id: firstSale.id,
          status: firstSale.status,
          line_items_count: firstSale.line_items?.length ?? 0,
          all_keys: Object.keys(firstSale),
        } : null,
      },
      sale_line_item: {
        // Show every field so we can see exact names for quantity/price
        sample: sampleSaleLineItem,
        all_keys: sampleSaleLineItem ? Object.keys(sampleSaleLineItem) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
