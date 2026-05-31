import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { password } = req.body || {};
  if (!password || password !== process.env.REPORT_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  const session = await getIronSession(req, res, sessionOptions);
  session.authed = true;
  await session.save();
  res.json({ ok: true });
}
