import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Index of pre-rendered filler clips that the Python telegram-voice
 * service writes into `telegram-voice/filler-cache/`. The browser
 * reads this list and streams each clip individually from
 * `/api/filler/clip/[id]` so the Spar UI can play filler content
 * during Claude's thinking window — exactly like the Telegram call
 * path does, using the same WAV pool.
 *
 * No synthesis happens on the dashboard side; we reuse whatever the
 * Python service has already baked. Empty cache = empty response and
 * the client falls back to the windchime hum.
 */

const CACHE_ROOT = path.resolve(process.cwd(), "telegram-voice", "filler-cache");
// Matches filler_manager.py's filename convention: "{kind}-{hash}.wav"
// where kind is news (the only content kind now that fun facts have
// been removed). silence-<ms>ms.wav is a separate naming branch so
// the main-pool filter can exclude it cleanly.
const CLIP_RE = /^(news)-[0-9a-f]{16}\.wav$/i;
const SILENCE_RE = /^silence-(\d+)ms\.wav$/i;

interface ClipMeta {
  id: string;     // filename without .wav — URL-safe ids
  kind: "news";
  /** Headline title from the sidecar JSON the Python service writes
   *  next to the WAV. Null when the sidecar is missing (older clips
   *  rendered before the sidecar feature shipped) so the client can
   *  fall back to a generic "News headline" label. */
  title: string | null;
  /** Source label (e.g. "BBC News Middle East"). Same caveat as
   *  `title`. */
  source: string | null;
}

interface IndexResponse {
  clips: ClipMeta[];
  silenceBridgeId: string | null;
}

async function readSidecar(
  name: string,
): Promise<{ title: string | null; source: string | null }> {
  const sidecarPath = path.join(
    CACHE_ROOT,
    `${name.replace(/\.wav$/i, "")}.json`,
  );
  try {
    const raw = await readFile(sidecarPath, "utf-8");
    const parsed = JSON.parse(raw) as { title?: unknown; label?: unknown };
    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : null;
    const source =
      typeof parsed.label === "string" && parsed.label.trim()
        ? parsed.label.trim()
        : null;
    return { title, source };
  } catch {
    return { title: null, source: null };
  }
}

export async function GET(): Promise<NextResponse> {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  let entries: string[];
  try {
    entries = await readdir(CACHE_ROOT);
  } catch {
    // Cache directory doesn't exist yet — Python service hasn't run
    // on this box. Respond with an empty index; the client gracefully
    // falls back to the hum.
    return NextResponse.json({ clips: [], silenceBridgeId: null } satisfies IndexResponse);
  }
  const clips: ClipMeta[] = [];
  let silenceBridgeId: string | null = null;
  // Collect WAV names first so we can read their sidecars in parallel
  // — readdir + many readFile calls are cheap enough that the index
  // endpoint stays sub-millisecond on a warm cache.
  const wavNames: string[] = [];
  for (const name of entries) {
    const clipMatch = name.match(CLIP_RE);
    if (clipMatch) {
      wavNames.push(name);
      continue;
    }
    const silenceMatch = name.match(SILENCE_RE);
    if (silenceMatch) {
      // Prefer the 500 ms bridge the Python side generates by default;
      // if there are multiple, the longest wins on the assumption a
      // longer bridge is more deliberate.
      const ms = Number(silenceMatch[1]);
      const currentMs = silenceBridgeId
        ? Number((silenceBridgeId.match(/silence-(\d+)ms/) ?? [])[1] ?? 0)
        : 0;
      if (ms >= currentMs) {
        silenceBridgeId = name.replace(/\.wav$/i, "");
      }
    }
  }
  const sidecars = await Promise.all(wavNames.map(readSidecar));
  for (let i = 0; i < wavNames.length; i++) {
    clips.push({
      id: wavNames[i].replace(/\.wav$/i, ""),
      kind: "news",
      title: sidecars[i].title,
      source: sidecars[i].source,
    });
  }
  return NextResponse.json({ clips, silenceBridgeId } satisfies IndexResponse, {
    headers: {
      // Index is cheap to regenerate and changes as the Python
      // prerender progresses — don't let it get cached.
      "Cache-Control": "no-store",
    },
  });
}
