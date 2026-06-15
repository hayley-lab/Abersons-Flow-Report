// Server-side Lightspeed token management.
//
// Prefer the OAuth refresh-token flow (LS_REFRESH_TOKEN) and cache refreshed
// access tokens in KV. A static LS_ACCESS_TOKEN remains available for local or
// emergency setups that do not need token refresh.
import { kv } from "@vercel/kv";

export function lsBase() {
  return `https://${process.env.LS_DOMAIN_PREFIX}.retail.lightspeed.app/api`;
}

export async function getLsToken() {
  // Static token path — no refresh needed
  if (!process.env.LS_REFRESH_TOKEN) {
    if (!process.env.LS_ACCESS_TOKEN) {
      throw new Error("Neither LS_REFRESH_TOKEN nor LS_ACCESS_TOKEN is set");
    }
    return process.env.LS_ACCESS_TOKEN;
  }

  // Refresh-token path — cache the access token in KV
  const cached = await kv.get("ls:token");
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }
  const res = await fetch("https://id.lightspeed.app/oauth/token", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.LS_CLIENT_ID,
      client_secret: process.env.LS_CLIENT_SECRET,
      refresh_token: process.env.LS_REFRESH_TOKEN,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LS token refresh failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const token = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await kv.set("ls:token", token, { ex: Math.max(data.expires_in - 120, 60) });
  return token.accessToken;
}
