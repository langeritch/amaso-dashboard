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
  const id = await getSessionIdFromCookies();
  if (!id) return null;
  return userFromSession(id);
}
