// Entry point for demo mode.
//
//   GET /demo  →  set `amaso_demo` cookie, 302 → /login
//
// Everything else is wired from there: getCurrentUser() reads the cookie
// and returns the synthetic DEMO_USER, server data helpers return fake
// data for that user, and the client-side DemoOverlay (mounted in the
// root layout) runs the login animation + cursor tour.
//
// Rendered as a route handler so we can `Set-Cookie` before redirecting
// — server components in Next can't set cookies.

import { NextResponse } from "next/server";
import { DEMO_COOKIE, DEMO_ENABLED } from "@/lib/demo/session";

export const dynamic = "force-dynamic";

export function GET() {
  // Kill-switch branch: when the demo is disabled, any visitor hitting
  // /demo (or carrying a stale cookie from a previous session) gets
  // wiped and bounced to the real landing page. This is how we flush
  // the cookie off browsers that were pinned into demo mode.
  if (!DEMO_ENABLED) {
    const res = new NextResponse(null, {
      status: 307,
      headers: { Location: "/" },
    });
    res.cookies.set({
      name: DEMO_COOKIE,
      value: "",
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 0,
    });
    return res;
  }

  // Use a RELATIVE Location so the browser resolves the redirect against
  // whatever host the visitor actually loaded (dashboard.amaso.nl in
  // production, localhost in dev). Constructing an absolute URL from
  // `req.url` picks up the server's bound hostname (0.0.0.0:3737) and
  // redirects the visitor to an unreachable address behind the tunnel.
  const res = new NextResponse(null, {
    status: 307,
    headers: { Location: "/login" },
  });
  res.cookies.set({
    name: DEMO_COOKIE,
    value: "1",
    path: "/",
    // NOT httpOnly — the client overlay reads this to decide whether to
    // mount. It isn't an auth secret, just a mode flag.
    httpOnly: false,
    sameSite: "lax",
    maxAge: 60 * 60 * 2, // 2 hours is plenty for a portfolio tour
  });
  return res;
}
