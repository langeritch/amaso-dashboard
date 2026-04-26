import fs from "node:fs";
import path from "node:path";
import type { User } from "./db";

const HEARTBEAT_DIR = path.resolve(process.cwd(), "data", "heartbeat");

// Santi is the super-super user. Every admin has their own heartbeat; only
// this email can touch someone else's file.
const SUPER_USER_EMAIL = "sander@vanderkraayswanjones.com";

function ensureDir(): void {
  fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
}

function pathFor(userId: number): string {
  return path.join(HEARTBEAT_DIR, `${userId}.md`);
}

export function isSuperUser(user: User): boolean {
  return user.role === "admin" && user.email === SUPER_USER_EMAIL;
}

export function canEditHeartbeat(viewer: User, ownerId: number): boolean {
  if (viewer.id === ownerId) return true;
  return isSuperUser(viewer);
}

export function readHeartbeat(userId: number): string {
  ensureDir();
  const p = pathFor(userId);
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function writeHeartbeat(userId: number, contents: string): void {
  ensureDir();
  fs.writeFileSync(pathFor(userId), contents, "utf8");
}

export function listHeartbeats(): { userId: number; bytes: number; mtime: number }[] {
  ensureDir();
  const out: { userId: number; bytes: number; mtime: number }[] = [];
  for (const name of fs.readdirSync(HEARTBEAT_DIR)) {
    const m = name.match(/^(\d+)\.md$/);
    if (!m) continue;
    const userId = Number(m[1]);
    const st = fs.statSync(path.join(HEARTBEAT_DIR, name));
    out.push({ userId, bytes: st.size, mtime: st.mtimeMs });
  }
  return out;
}
