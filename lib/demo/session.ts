// Server-side demo-mode plumbing. A single cookie toggles the entire
// app into a read-only fake-data mode: every auth and data helper that
// matters branches on `user.id === DEMO_USER.id`, and the client-side
// DemoOverlay stubs out websocket + /api fetches so the real UI renders
// from the seeded SSR payload without hitting the network.
//
// Design notes:
// - DEMO_COOKIE is deliberately NOT HttpOnly — the client overlay reads
//   it via document.cookie to decide whether to mount. It's a mode flag,
//   not a session secret.
// - DEMO_USER.id is negative, which SQLite's AUTOINCREMENT will never
//   produce, so branching on it in data helpers is unambiguous.

import type { User } from "../db";

/** Master kill switch for demo mode. When false:
 *  - the /demo route clears any stale cookie and redirects to /
 *  - DemoOverlay never mounts (and wipes the cookie if it finds one)
 *  - isDemoUser / isDemoRequest always return false
 *  - the pre-hydration fetch/WS stub in the root layout is not injected
 *  Flip back to true to re-enable the walkthrough. */
export const DEMO_ENABLED = true;

export const DEMO_COOKIE = "amaso_demo";

export const DEMO_USER: User = {
  id: -1,
  email: "demo@amaso.nl",
  name: "Santi van der Kraay",
  role: "admin",
  created_at: 0,
};

export function isDemoUser(u: { id: number } | null | undefined): boolean {
  if (!DEMO_ENABLED) return false;
  return !!u && u.id === DEMO_USER.id;
}

/** Async server-side check: is the current request in demo mode? Import
 *  only from App Router server code; the WS / CLI paths don't have
 *  `next/headers`. */
export async function isDemoRequest(): Promise<boolean> {
  if (!DEMO_ENABLED) return false;
  // Dynamic import so files that transitively pull this one into the WS
  // server don't also pull next/headers (which throws outside App Router).
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return store.get(DEMO_COOKIE)?.value === "1";
}
