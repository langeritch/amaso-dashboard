import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getCurrentUser, userCount } from "./auth";
import type { User } from "./db";
import { isSuperUser } from "./heartbeat";

/**
 * Server-component helper. Sends the visitor to /setup if no users exist yet,
 * to /login if they're not signed in, or returns the current user.
 *
 * Internal-dashboard pages should call this. Clients are routed away to the
 * dedicated /client portal — they should never see Spar, Projects, Brain,
 * Heartbeat, Activity, Remarks, Settings, etc. Use `requireClient()` from
 * inside /client routes instead.
 */
export async function requireUser(): Promise<User> {
  if (userCount() === 0) redirect("/setup");
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "client") redirect("/client");
  return user;
}

/**
 * Server-component helper for the /client portal. Redirects unauthenticated
 * visitors to /login and admin/team users back to the internal dashboard
 * home (the portal is a client-only surface).
 */
export async function requireClient(): Promise<User> {
  if (userCount() === 0) redirect("/setup");
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "client") redirect("/");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}

/** API-route helper. Returns a NextResponse on failure, or the user on success. */
export async function apiRequireUser(): Promise<
  { ok: true; user: User } | { ok: false; res: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      res: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, user };
}

/**
 * API-route helper for internal-tool endpoints. Identical to
 * `apiRequireUser` except it 403s when the caller's role is "client".
 * Apply to spar / activity / claude-accounts / graph / filler /
 * telegram (dashboard-side) / tts / youtube routes — anything the
 * client portal doesn't legitimately reach.
 *
 * Page-level isolation already redirects clients away from the
 * surfaces that fire these requests, so a 403 here is a defence-in-
 * depth fence against a hand-crafted request, not a flow the UI is
 * expected to hit.
 */
export async function apiRequireNonClient(): Promise<
  { ok: true; user: User } | { ok: false; res: NextResponse }
> {
  const result = await apiRequireUser();
  if (!result.ok) return result;
  if (result.user.role === "client") {
    return {
      ok: false,
      res: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  return result;
}

export async function apiRequireAdmin(): Promise<
  { ok: true; user: User } | { ok: false; res: NextResponse }
> {
  const result = await apiRequireUser();
  if (!result.ok) return result;
  if (result.user.role !== "admin") {
    return {
      ok: false,
      res: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  return result;
}

/**
 * API-route guard for super-user-only endpoints. Returns 401 for
 * unauthenticated requests and 403 for any logged-in user who isn't
 * the super-user (including other admins). Use this for endpoints
 * that touch the dashboard owner's private surface — activity
 * tracking, destructive global rebuilds, etc.
 *
 * The super-user check itself lives in `lib/heartbeat.ts`
 * (`isSuperUser`) — single source of truth for the email-pinned
 * gate, reused server-side in pages and APIs.
 */
export async function apiRequireSuperUser(): Promise<
  { ok: true; user: User } | { ok: false; res: NextResponse }
> {
  const result = await apiRequireUser();
  if (!result.ok) return result;
  if (!isSuperUser(result.user)) {
    return {
      ok: false,
      res: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  return result;
}
