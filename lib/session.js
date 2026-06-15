// Shared Iron Session options for staff-facing pages and API routes.
// The cookie stores auth/session metadata only; scan data and imported old-report
// records live in Vercel KV.
export const sessionOptions = {
  password: process.env.SESSION_SECRET,
  cookieName: "flow_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};
