import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Screenshots / pasted images that the user wants Claude to see end up
// on disk under this root. Claude Code reads the absolute path we print
// into the terminal through its normal Read tool — nothing special is
// needed on the PTY side.
const ROOT = path.resolve(process.cwd(), "data", "terminal-uploads");
const MAX_BYTES = 10 * 1024 * 1024;

export class UploadError extends Error {}

function safeBucket(raw: string): string {
  return /^[a-zA-Z0-9_\-]{1,64}$/.test(raw) ? raw : "_invalid";
}

function extFor(mime: string, name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  if (m) return `.${m[1].toLowerCase()}`;
  const fromMime: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  return fromMime[mime] ?? ".img";
}

export async function saveImage(bucket: string, file: File): Promise<string> {
  if (!file.type || !file.type.startsWith("image/")) {
    throw new UploadError(`unsupported_type:${file.type || "unknown"}`);
  }
  if (file.size === 0) throw new UploadError("empty");
  if (file.size > MAX_BYTES) throw new UploadError("file_too_large");

  let buf: Buffer = Buffer.from(await file.arrayBuffer());
  let mime = file.type;
  let srcName = file.name;
  // iOS sometimes hands us HEIC even for screenshots (when iCloud is
  // storage-optimising the device). Claude's Read tool — and most of
  // the web — can't decode HEIC, so transcode to JPEG server-side
  // before anything else touches the file. Pure-JS decoder, slow but
  // zero native deps to install on a Windows + Syncthing setup.
  if (isHeic(mime, srcName)) {
    buf = await heicToJpeg(buf);
    mime = "image/jpeg";
    srcName = srcName.replace(/\.(heic|heif)$/i, ".jpg");
  }

  const name = `${crypto.randomUUID()}${extFor(mime, srcName)}`;
  const dir = path.join(ROOT, safeBucket(bucket));
  await fs.mkdir(dir, { recursive: true });
  const abs = path.join(dir, name);
  await fs.writeFile(abs, buf);
  return abs.replace(/\\/g, "/");
}

function isHeic(mime: string, name: string): boolean {
  if (mime === "image/heic" || mime === "image/heif") return true;
  return /\.(heic|heif)$/i.test(name);
}

async function heicToJpeg(input: Buffer): Promise<Buffer> {
  const { default: convert } = await import("heic-convert");
  const out = await convert({ buffer: input, format: "JPEG", quality: 0.92 });
  return Buffer.from(out);
}

// In-memory one-shot tokens for the PWA share-target flow. The share
// sheet hands us an image before we know which project the user wants
// to drop it into, so we issue a token, redirect to the app, and let
// whichever TerminalPane opens next claim the token for its absolute
// path. Ten-minute TTL covers the user walking through the UI; any
// longer and the screenshot isn't relevant anymore.
const TOKENS = new Map<string, { path: string; expires: number }>();
const TOKEN_TTL_MS = 10 * 60 * 1000;

export function issueShareToken(absPath: string): string {
  const token = crypto.randomBytes(18).toString("base64url");
  TOKENS.set(token, { path: absPath, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function claimShareToken(token: string): string | null {
  const entry = TOKENS.get(token);
  if (!entry) return null;
  TOKENS.delete(token);
  if (entry.expires < Date.now()) return null;
  return entry.path;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, v] of TOKENS) if (v.expires < now) TOKENS.delete(t);
}, 60_000).unref();
