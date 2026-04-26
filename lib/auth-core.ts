// Parts of the auth layer that are safe to import outside an App-Router
// request scope — from the custom server, the WebSocket handler, and the CLI.
// Anything touching `next/headers` (cookies) lives in auth.ts.
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb, publicUser, type User } from "./db";

export const SESSION_COOKIE = "amaso_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SECRET_PATH = path.resolve(process.cwd(), "data", ".session-secret");

let cachedSecret: Buffer | null = null;
function sessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  if (fs.existsSync(SECRET_PATH)) {
    cachedSecret = fs.readFileSync(SECRET_PATH);
  } else {
    cachedSecret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_PATH, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}

export function sign(value: string): string {
  const mac = crypto
    .createHmac("sha256", sessionSecret())
    .update(value)
    .digest("base64url");
  return `${value}.${mac}`;
}

export function verifySigned(signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const expected = sign(value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return value;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function createSession(userId: number): {
  id: string;
  expiresAt: number;
} {
  const id = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  getDb()
    .prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, userId, now, expiresAt);
  return { id, expiresAt };
}

export function destroySession(sessionId: string) {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function userFromSession(sessionId: string): User | null {
  const row = getDb()
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.created_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(sessionId) as
    | {
        id: number;
        email: string;
        name: string;
        role: User["role"];
        created_at: number;
        expires_at: number;
      }
    | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(sessionId);
    return null;
  }
  return publicUser(row);
}

export function sessionIdFromHeader(
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(/;\s*/)) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx);
    const v = pair.slice(idx + 1);
    if (k === SESSION_COOKIE) return verifySigned(decodeURIComponent(v));
  }
  return null;
}

export function userCount(): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  return r.n;
}
