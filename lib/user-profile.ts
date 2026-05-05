import fs from "node:fs";
import path from "node:path";

const PROFILE_DIR = path.resolve(process.cwd(), "data", "user-profile");

function ensureDir(): void {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

function pathFor(userId: number): string {
  return path.join(PROFILE_DIR, `${userId}.md`);
}

export function readProfile(userId: number): string {
  try {
    return fs.readFileSync(pathFor(userId), "utf8");
  } catch {
    return "";
  }
}

export function writeProfile(userId: number, contents: string): void {
  ensureDir();
  fs.writeFileSync(pathFor(userId), contents, "utf8");
}
