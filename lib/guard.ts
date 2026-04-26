import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getCurrentUser, userCount } from "./auth";
import type { User } from "./db";
import { isSuperUser } from "./heartbeat";

/**
 * Server-component helper. Sends the visitor to /setup if no users exist yet,
 * to /login if they're not signed in, or returns the current user.
 */
export async function requireUser(): Promise<User> {
  if (userCount() === 0) redirect("/setup");
  const user = await getCurrentUser();
  if (!user) redirect("/login");
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
