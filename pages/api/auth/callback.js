// pages/api/auth/callback.js
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`/?error=${encodeURIComponent(error || "no_code")}`);
  }

  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `${proto}://${host}`;
    const redirectUri = `${baseUrl}/api/auth/callback`;

    const tokenRes = await fetch("https://id.lightspeed.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.LS_CLIENT_ID,
        client_secret: process.env.LS_CLIENT_SECRET,
        redirect_uri: redirectUri,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("Token exchange failed:", text);
      return res.redirect(`/?error=token_exchange_failed`);
    }

    const tokenData = await tokenRes.json();
    // tokenData: { access_token, refresh_token, token_type, expires_in, scope, domainPrefix }

    const session = await getIronSession(req, res, sessionOptions);
    session.accessToken = tokenData.access_token;
    session.refreshToken = tokenData.refresh_token;
    session.expiresAt = Date.now() + tokenData.expires_in * 1000;
    session.domainPrefix = tokenData.domainPrefix || tokenData.domain || "";
    await session.save();

    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
}
