import { getIronSession } from "iron-session";
import { sessionOptions } from "../../lib/session";
import { getLsToken, lsBase } from "../../lib/ls-auth";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "id required" });

  const token = await getLsToken();
  const base  = lsBase();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function get(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: { raw: text.slice(0, 1000) } }; }
  }

  const [plain, withInv, withLevels] = await Promise.all([
    get(`2.0/products/${id}`),
    get(`2.0/products/${id}?include=inventory`),
    get(`2.0/products/${id}?include=inventory_levels`),
  ]);

  return res.json({
    plain:             plain.body.data       || plain.body,
    with_inventory:    withInv.body.data     || withInv.body,
    with_inv_levels:   withLevels.body.data  || withLevels.body,
  });
}
