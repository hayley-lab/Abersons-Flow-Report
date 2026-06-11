// Temporary probe: inspect the Lightspeed /search endpoint response shape so we
// can confirm it returns the fields the scan needs (cost/sku/variant for
// products, line items for sales) before migrating the scan onto it.
import { getLsToken, lsBase } from "../../lib/ls-auth";
import { rateLimitInfoFromHeaders } from "../../lib/ls-fetch";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const token = await getLsToken();
  const base = lsBase();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function probe(path) {
    const response = await fetch(`${base}/${path}`, { headers, cache: "no-store" });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = { raw: "non-json" };
    }
    return {
      path,
      ok: response.ok,
      status: response.status,
      rateLimit: rateLimitInfoFromHeaders(response.headers),
      data,
    };
  }

  // /search has historically lived under a couple of version prefixes; find one
  // that responds so we know which path the helper should use.
  const versionCandidates = ["2.0", "2026-04", "2.1"];
  let productProbe = null;
  let usedVersion = null;
  for (const v of versionCandidates) {
    const p = await probe(`${v}/search?type=products&page_size=3`);
    if (p.ok || p.status !== 404) {
      productProbe = p;
      usedVersion = v;
      break;
    }
    productProbe = p;
  }

  const products = productProbe?.data?.data || [];
  const firstProduct = products[0] || null;

  const salesProbe = usedVersion
    ? await probe(`${usedVersion}/search?type=sales&page_size=2`)
    : null;
  const sales = salesProbe?.data?.data || [];
  const firstSale = sales[0] || null;
  const firstLineItem = (firstSale?.line_items || firstSale?.register_sale_products || [])[0] || null;

  return res.json({
    usedVersion,
    products: {
      ok: productProbe?.ok,
      status: productProbe?.status,
      rateLimit: productProbe?.rateLimit,
      returnedCount: products.length,
      hasVersionCursor: !!productProbe?.data?.version,
      firstProductKeys: firstProduct ? Object.keys(firstProduct) : [],
      firstProductFields: firstProduct
        ? pick(firstProduct, [
            "id",
            "sku",
            "name",
            "variant_name",
            "price",
            "price_excluding_tax",
            "price_including_tax",
            "retail_price",
            "supply_price",
            "supplier_id",
            "supplier",
            "product_type_id",
            "variant_parent_id",
            "active",
            "deleted_at",
          ])
        : null,
    },
    sales: {
      ok: salesProbe?.ok,
      status: salesProbe?.status,
      returnedCount: sales.length,
      firstSaleKeys: firstSale ? Object.keys(firstSale) : [],
      lineItemArrayKey: firstSale?.line_items
        ? "line_items"
        : firstSale?.register_sale_products
          ? "register_sale_products"
          : null,
      firstLineItemKeys: firstLineItem ? Object.keys(firstLineItem) : [],
      firstLineItemFields: firstLineItem
        ? pick(firstLineItem, [
            "product_id",
            "quantity",
            "price",
            "price_total",
            "total_price",
            "discount",
            "discount_total",
            "is_return",
          ])
        : null,
    },
  });
}
