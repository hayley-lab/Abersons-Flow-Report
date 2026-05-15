// pages/api/auth/lightspeed.js
export default function handler(req, res) {
  const clientId = process.env.LS_CLIENT_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/callback`;

  const scope = [
    "employee:all",
    "inventory:all",
    "product:all",
    "sale:all",
    "purchase_order:all",
  ].join(" ");

  // Build URL manually so colons in scope values are not percent-encoded (%3A),
  // which some OAuth servers reject.
  const url =
    `https://id.lightspeed.app/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scope.replace(/ /g, "+")}`;

  res.redirect(url);
}
