import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { getLsToken, lsBase } from "../../../lib/ls-auth";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  let token;
  try {
    token = await getLsToken();
  } catch (e) {
    return res.status(503).json({ error: "LS auth failed: " + e.message });
  }

  const { path } = req.query;
  const pathStr = Array.isArray(path) ? path.join("/") : path;
  const query = { ...req.query };
  delete query.path;
  const queryStr = new URLSearchParams(query).toString();
  const url = `${lsBase()}/${pathStr}${queryStr ? "?" + queryStr : ""}`;

  try {
    const lsRes = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
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
