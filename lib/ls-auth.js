// Server-side Lightspeed token management.
//
// Prefer the OAuth refresh-token flow (LS_REFRESH_TOKEN) and cache refreshed
// access tokens in KV. A static LS_ACCESS_TOKEN remains available for local or
// emergency setups that do not need token refresh.
import { kv } from "@vercel/kv";

export function lsBase() {
  return `https://${process.env.LS_DOMAIN_PREFIX}.retail.lightspeed.app/api`;
}

// Connection-health signal for the UI. The cron-driven LS paths (scan/delta)
// write this so a broken token / expired auth is visible in the app instead of
// only showing up as a stalled scan. Best-effort: never let a health write or
// read break the caller. TTL auto-clears a stale "ok" if nothing runs for a day.
export const LS_HEALTH_KEY = "ls:health";
const LS_HEALTH_TTL = 24 * 60 * 60;

export async function setLsHealth(status, detail = null) {
  try {
    await kv.set(
      LS_HEALTH_KEY,
      { status, detail: detail ? String(detail).slice(0, 200) : null, ts: Date.now() },
      { ex: LS_HEALTH_TTL }
    );
  } catch {
    // health signal is advisory — swallow KV errors
  }
}

export async function getLsHealth() {
  try {
    return (await kv.get(LS_HEALTH_KEY)) || null;
  } catch {
    return null;
  }
}

// Fire-and-forget marker for an auth failure (401/403 from LS, or a refresh
// failure). Safe to call from a synchronous onAuthError hook.
export function markLsAuthError(detail) {
  setLsHealth("error", detail).catch(() => {});
}

// Fire-and-forget marker that LS is reachable and the token works. Called at the
// end of a successful scan/delta step so a prior error state clears.
export function markLsHealthy() {
  setLsHealth("ok").catch(() => {});
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
    await setLsHealth("error", `token refresh failed (${res.status})`);
    throw new Error(`LS token refresh failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  await setLsHealth("ok");
  const token = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await kv.set("ls:token", token, { ex: Math.max(data.expires_in - 120, 60) });
  return token.accessToken;
}
