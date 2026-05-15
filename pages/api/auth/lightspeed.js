// pages/api/auth/lightspeed.js
export default function handler(req, res) {
  const clientId = process.env.LS_CLIENT_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/callback`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: [
      "employee:all",
      "inventory:all",
      "product:all",
      "sale:all",
      "purchase_order:all",
      "report:inventory_all",
    ].join(" "),
  });

  res.redirect(
    `https://id.lightspeed.app/oauth/authorize?${params.toString()}`
  );
}
