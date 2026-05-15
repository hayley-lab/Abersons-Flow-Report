// pages/api/ls/[...path].js
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);

  if (!session.accessToken || !session.domainPrefix) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { path } = req.query;
  const pathStr = Array.isArray(path) ? path.join("/") : path;

  // Forward query params (except Next.js internal 'path')
  const query = { ...req.query };
  delete query.path;
  const queryStr = new URLSearchParams(query).toString();

  const url = `https://${session.domainPrefix}.retail.lightspeed.app/api/${pathStr}${queryStr ? "?" + queryStr : ""}`;

  try {
    const lsRes = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
    });

    const data = await lsRes.json();

    if (!lsRes.ok) {
      return res.status(lsRes.status).json(data);
    }

    res.status(200).json(data);
  } catch (err) {
    console.error("LS proxy error:", err);
    res.status(500).json({ error: err.message });
  }
}
