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

  try {
    // 1. Fetch a single page of sales WITHOUT include — see base structure
    const salesBasic = await lsFetch("2.0/sales?page_size=1");

    // 2. Fetch a single page of sales WITH include=line_items
    const salesWithLineItems = await lsFetch("2.0/sales?page_size=1&include=line_items");

    // 3. Try fetching line items for the first sale individually
    const firstSaleId = salesBasic?.data?.[0]?.id;
    let saleLineItemsDirect = null;
    if (firstSaleId) {
      saleLineItemsDirect = await lsFetch(`2.0/sales/${firstSaleId}/line_items?page_size=5`);
    }

    // 4. Check what fields a sale has (keys only, to understand structure)
    const firstSaleBasicKeys = salesBasic?.data?.[0] ? Object.keys(salesBasic.data[0]) : [];
    const firstSaleWithIncludeKeys = salesWithLineItems?.data?.[0] ? Object.keys(salesWithLineItems.data[0]) : [];

    res.status(200).json({
      // Basic sale structure
      first_sale_id: firstSaleId,
      first_sale_basic_keys: firstSaleBasicKeys,
      first_sale_basic_sample: salesBasic?.data?.[0],

      // With include=line_items — does it add line_items key?
      first_sale_with_include_keys: firstSaleWithIncludeKeys,
      first_sale_line_items_via_include: salesWithLineItems?.data?.[0]?.line_items,
      sales_include_error: salesWithLineItems?.errors || null,

      // Direct line items endpoint
      line_items_direct_endpoint: saleLineItemsDirect?.data?.slice(0, 3) || saleLineItemsDirect,

      // Pagination info
      sales_pagination: salesBasic?.pagination || salesBasic?.version,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
