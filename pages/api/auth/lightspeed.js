// pages/api/auth/lightspeed.js
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const clientId = process.env.LS_CLIENT_ID;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `${proto}://${host}`;
  const redirectUri = `${baseUrl}/api/auth/callback`;

  const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const session = await getIronSession(req, res, sessionOptions);
  session.oauthState = state;
  await session.save();

  const scope = ["products:read", "sales:read", "consignments:read"].join(" ");

  const url =
    `https://secure.retail.lightspeed.app/connect` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scope.replace(/ /g, "+")}` +
    `&state=${encodeURIComponent(state)}`;

  if (req.query.debug === "1") {
    return res.status(200).json({ url, clientId, redirectUri, scope });
  }
  res.redirect(url);
}
