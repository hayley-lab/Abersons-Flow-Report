// pages/api/auth/debug-token.js — shows what scopes the current session token has
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  const { accessToken, domainPrefix, expiresAt } = session;

  if (!accessToken || !domainPrefix) {
    return res.status(401).json({ error: "Not authenticated — no session token found." });
  }

  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  async function probe(path) {
    try {
      const r = await fetch(`${base}/${path}`, { headers });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
      return { status: r.status, ok: r.ok, body };
    } catch (e) {
      return { status: null, ok: false, error: e.message };
    }
  }

  const [tagsResult, productsResult, salesResult, consignResult] = await Promise.all([
    probe("2.0/tags?page_size=1"),
    probe("2.0/products?page_size=1"),
    probe("2.0/sales?page_size=1"),
    probe("2.0/consignments?type=SUPPLIER&page_size=1"),
  ]);

  // Inspect sales pagination and structure
  const salesBody = salesResult.body;
  const firstSale = salesBody?.data?.[0];

  res.status(200).json({
    session: {
      domainPrefix,
      tokenLength: accessToken?.length,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      expired: expiresAt ? Date.now() > expiresAt : null,
    },
    endpoints: {
      "2.0/tags":         { status: tagsResult.status, ok: tagsResult.ok },
      "2.0/products":     { status: productsResult.status, ok: productsResult.ok },
      "2.0/sales":        { status: salesResult.status, ok: salesResult.ok },
      "2.0/consignments": { status: consignResult.status, ok: consignResult.ok },
    },
    sales_pagination: {
      top_level_keys: salesBody ? Object.keys(salesBody) : null,
      pagination_field: salesBody?.pagination ?? null,
      meta_field: salesBody?.meta ?? null,
      version_field: salesBody?.version ?? null,
      sales_count_in_page: salesBody?.data?.length ?? 0,
      first_sale_date: firstSale?.sale_date ?? firstSale?.created_at ?? null,
      first_sale_status: firstSale?.status ?? null,
      first_sale_line_items_count: firstSale?.line_items?.length ?? "missing",
    },
  });
}
