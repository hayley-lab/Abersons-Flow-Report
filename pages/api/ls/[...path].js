// pages/api/ls/[...path].js
export default async function handler(req, res) {
  const accessToken = process.env.LS_ACCESS_TOKEN;
  const domainPrefix = process.env.LS_DOMAIN_PREFIX;

  if (!accessToken || !domainPrefix) {
    return res.status(500).json({ error: "Lightspeed credentials not configured" });
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

    if (!lsRes.ok) {
      return res.status(lsRes.status).json(data);
    }

    res.status(200).json(data);
  } catch (err) {
    console.error("LS proxy error:", err);
    res.status(500).json({ error: err.message });
  }
}
