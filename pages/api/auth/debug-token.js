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

  res.status(200).json({
    session: {
      domainPrefix,
      tokenLength: accessToken?.length,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      expired: expiresAt ? Date.now() > expiresAt : null,
    },
    endpoints: {
      "2.0/tags":         tagsResult,
      "2.0/products":     productsResult,
      "2.0/sales":        salesResult,
      "2.0/consignments": consignResult,
    },
  });
}
