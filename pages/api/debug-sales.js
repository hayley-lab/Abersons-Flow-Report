// Temporary debug: fetch recent sales and show raw line item fields for
// any line items that look like returns or discounts.
import { getLsToken, lsBase } from "../../lib/ls-auth";
import { rateLimitInfoFromHeaders } from "../../lib/ls-fetch";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const token = await getLsToken();
  const base = lsBase();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function fetchProbe(path) {
    const response = await fetch(`${base}/${path}`, { headers, cache: "no-store" });
    const data = await response.json();
    return {
      ok: response.ok,
      status: response.status,
      data,
      rateLimit: rateLimitInfoFromHeaders(response.headers),
    };
  }

  // Probe a 500-row request to verify whether LS caps 2.0/sales at 200 rows.
  const requestedPageSize = 500;
  const probePath = `2.0/sales?page_size=${requestedPageSize}&date_from=2026-01-01`;
  const probe = await fetchProbe(probePath);
  if (!probe.ok) {
    return res.status(502).json({
      error: "Lightspeed sales probe failed",
      status: probe.status,
      rateLimit: probe.rateLimit,
      response: probe.data,
    });
  }

  const sales = probe.data.data || [];

  const interesting = [];
  for (const sale of sales) {
    for (const li of sale.line_items || []) {
      const hasDiscount = parseFloat(li.discount || li.line_discount || li.discount_total || 0) > 0;
      const isReturn = !!li.is_return;
      const zeroPrice = parseFloat(li.total_price ?? li.price ?? 1) === 0;
      if (hasDiscount || isReturn || zeroPrice) {
        interesting.push({
          sale_id: sale.id,
          sale_status: sale.status,
          // show ALL fields on the line item so we can see exact names
          line_item: li,
        });
        if (interesting.length >= 20) break;
      }
    }
    if (interesting.length >= 20) break;
  }

  return res.json({
    requestedPageSize,
    returnedCount: sales.length,
    version: probe.data.version || null,
    rateLimit: probe.rateLimit,
    count: interesting.length,
    samples: interesting,
  });
}
