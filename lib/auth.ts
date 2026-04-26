// App-Router-only auth helpers: anything that touches `next/headers`
// (cookies, redirects) lives here. Custom server / WS / CLI should import
// from `auth-core.ts` instead.
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  sign,
  userFromSession,
  verifySigned,
} from "./auth-core";
import type { User } from "./db";

export {
  createSession,
  destroySession,
  hashPassword,
  sessionIdFromHeader,
  userCount,
  userFromSession,
  verifyPassword,
} from "./auth-core";

export async function setSessionCookie(sessionId: string, expiresAt: number) {
  const store = await cookies();
  store.set(SESSION_COOKIE, sign(sessionId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSessionIdFromCookies(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return verifySigned(raw);
}

export async function getCurrentUser(): Promise<User | null> {
  // Demo mode bypasses the entire session/auth path. See lib/demo/session.
  // Gated on DEMO_ENABLED — when the kill switch is off, a stale cookie
  // on a visitor's browser must not return DEMO_USER (which would skip
  // real auth and land them in the fake workspace).
  const { DEMO_COOKIE, DEMO_USER, DEMO_ENABLED } = await import("./demo/session");
  const store = await cookies();
  if (DEMO_ENABLED && store.get(DEMO_COOKIE)?.value === "1") return DEMO_USER;

  const id = await getSessionIdFromCookies();
  if (!id) return null;
  return userFromSession(id);
}
