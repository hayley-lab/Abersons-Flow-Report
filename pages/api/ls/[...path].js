import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  let { accessToken, refreshToken, expiresAt, domainPrefix } = session;

  if (!accessToken || !domainPrefix) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Refresh token if within 5 minutes of expiry
  if (expiresAt && Date.now() > expiresAt - 5 * 60 * 1000) {
    try {
      const r = await fetch(`https://${domainPrefix}.retail.lightspeed.app/api/1.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: process.env.LS_CLIENT_ID,
          client_secret: process.env.LS_CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
      });
      if (r.ok) {
        const d = await r.json();
        session.accessToken = d.access_token;
        session.refreshToken = d.refresh_token || refreshToken;
        session.expiresAt = Date.now() + d.expires_in * 1000;
        await session.save();
        accessToken = session.accessToken;
      } else {
        await session.destroy();
        return res.status(401).json({ error: "Session expired" });
      }
    } catch { /* continue with existing token on network error */ }
  }

  const { path } = req.query;
  const pathStr = Array.isArray(path) ? path.join("/") : path;
  const query = { ...req.query };
  delete query.path;
  const queryStr = new URLSearchParams(query).toString();
  const url = `https://${domainPrefix}.retail.lightspeed.app/api/${pathStr}${queryStr ? "?" + queryStr : ""}`;

  try {
    const lsRes = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
    });
    const data = await lsRes.json();
    if (!lsRes.ok) return res.status(lsRes.status).json(data);
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
