import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.accessToken || !session.domainPrefix) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season parameter required" });

  const base = `https://${session.domainPrefix}.retail.lightspeed.app/api`;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
  };

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: { raw: text.slice(0, 300) } };
    }
  }

  function getCursor(body, items) {
    const vfr = body.version && typeof body.version === "object" ? body.version.max : null;
    const vfi = items.reduce((mx, i) => Math.max(mx, i.version || 0), 0);
    return (vfr !== null ? vfr : vfi) || null;
  }

  try {
    let tags = [];
    let after = null;
    for (let p = 0; p < 20; p++) {
      const r = await lsFetch("2.0/tags?page_size=200" + (after ? "&after=" + after : ""));
      if (r.status !== 200) break;
      const items = r.body.data || [];
      tags = tags.concat(items);
      if (items.length < 200) break;
      after = getCursor(r.body, items);
      if (!after) break;
    }

    const seasonTag = tags.find((t) => t.name === season);
    if (!seasonTag) return res.json({ tag: null, products: [] });

    let products = [];
    after = null;
    for (let p = 0; p < 200; p++) {
      const r = await lsFetch(
        "2.0/products?tag_ids[]=" +
          seasonTag.id +
          "&page_size=200" +
          (after ? "&after=" + after : "")
      );
      if (r.status !== 200) break;
      const items = r.body.data || [];
      products = products.concat(items);
      if (items.length < 200) break;
      after = getCursor(r.body, items);
      if (!after) break;
    }

    return res.json({ tag: seasonTag, products });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
