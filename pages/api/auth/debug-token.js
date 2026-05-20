// pages/api/auth/debug-token.js — cross-references season products against sales
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  const { accessToken, domainPrefix } = session;

  if (!accessToken || !domainPrefix) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  async function ls(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    return r.json();
  }

  // 1. Find the prefall26 tag
  const tagsData = await ls("2.0/tags?page_size=200");
  const seasonTag = tagsData.data?.find((t) => t.name === "prefall26");

  // 2. Get a sample consignment and its first product
  const consignData = await ls("2.0/consignments?type=SUPPLIER&page_size=1");
  const firstConsign = consignData.data?.[0];
  let sampleProductId = null;
  let sampleProduct = null;

  if (firstConsign?.id) {
    const liData = await ls(`2.0/consignments/${firstConsign.id}/products?page_size=5`);
    const firstLi = liData.data?.[0];
    if (firstLi?.product_id) {
      sampleProductId = firstLi.product_id;
      const prodData = await ls(`2.0/products/${sampleProductId}`);
      sampleProduct = prodData.data || prodData;
    }
  }

  // 3. Fetch 200 sales and check how many line items have product_ids tagged with prefall26
  // Also check pagination structure with page_size=200
  const salesPage1 = await ls("2.0/sales?page_size=200");
  const sales200 = salesPage1.data || [];
  const allLineItems = sales200
    .filter((s) => s.status !== "VOIDED")
    .flatMap((s) => s.line_items || [])
    .filter((li) => li.product_id && li.status !== "VOIDED");

  // Unique product IDs appearing in those sales
  const saleProductIds = [...new Set(allLineItems.map((li) => li.product_id))];

  // 4. Check pagination: what happens with after=version.max?
  const v1Max = salesPage1.version?.max;
  let page2Count = 0;
  let page2Version = null;
  if (v1Max) {
    const salesPage2 = await ls(`2.0/sales?page_size=200&after=${v1Max}`);
    page2Count = salesPage2.data?.length ?? 0;
    page2Version = salesPage2.version ?? null;
  }

  res.status(200).json({
    season_tag: seasonTag ? { id: seasonTag.id, name: seasonTag.name } : "NOT FOUND",
    sample_consignment: firstConsign ? { id: firstConsign.id, status: firstConsign.status } : null,
    sample_product: sampleProduct ? {
      id: sampleProduct.id,
      name: sampleProduct.name,
      tag_ids: sampleProduct.tag_ids,
      has_prefall26_tag: seasonTag ? sampleProduct.tag_ids?.includes(seasonTag.id) : "unknown",
    } : null,
    sales_page1: {
      count: sales200.length,
      non_voided_line_items: allLineItems.length,
      unique_sale_product_ids: saleProductIds.length,
      version: salesPage1.version,
      date_range: {
        first: sales200[0]?.sale_date,
        last: sales200[sales200.length - 1]?.sale_date,
      },
    },
    sales_page2_after_max: {
      count: page2Count,
      version: page2Version,
    },
  });
}
