// pages/api/auth/session.js
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);

  if (!session.accessToken) {
    return res.json({ authenticated: false });
  }

  // Check if token needs refresh (within 5 min of expiry)
  if (session.expiresAt && Date.now() > session.expiresAt - 5 * 60 * 1000) {
    try {
      const refreshRes = await fetch("https://id.lightspeed.app/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: process.env.LS_CLIENT_ID,
          client_secret: process.env.LS_CLIENT_SECRET,
          refresh_token: session.refreshToken,
        }),
      });
      if (refreshRes.ok) {
        const data = await refreshRes.json();
        session.accessToken = data.access_token;
        session.refreshToken = data.refresh_token || session.refreshToken;
        session.expiresAt = Date.now() + data.expires_in * 1000;
        await session.save();
      } else {
        session.destroy();
        return res.json({ authenticated: false });
      }
    } catch {
      // silently continue with old token
    }
  }

  res.json({
    authenticated: true,
    domainPrefix: session.domainPrefix,
  });
}
