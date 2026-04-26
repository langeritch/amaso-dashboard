import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Filler-mode read/write helper. The single source of truth is
 * `telegram-voice/filler-config.json` — the Python filler_manager
 * reads it on every prerender and every playback decision, and the
 * dashboard reads/writes it here. Keeping one file on disk means
 * browser and Telegram can never disagree on which source should
 * be playing.
 *
 * Valid modes:
 *   "news"      — pre-rendered news clips. Middle-East prioritised
 *                 via the existing Python filler pipeline.
 *   "fun-facts" — curated trivia spoken via the dashboard's TTS
 *                 (DEFAULT). Sourced from `lib/filler-content/`.
 *   "calendar"  — upcoming items from the user's heartbeat / agenda,
 *                 spoken via TTS.
 *   "quiet"     — just the ambient windchime, no spoken content.
 *   "youtube"   — YouTube iframe plays on the dashboard during
 *                 thinking; Telegram falls back to news clips.
 *   "hum"       — alias of "quiet" kept for backwards compatibility.
 *   "off"       — silent, no chime, no content.
 *
 * Telegram-side normalise treats unknown modes as "news" so the
 * new TTS-content modes silently fall back to news clips on the
 * phone leg — the dashboard handles them natively.
 *
 * JSON shape on disk: `{ "mode": "...", "urlOrTopic": "..." }`.
 * `urlOrTopic` is optional and only persisted when non-empty, so
 * the steady-state file for the common case stays
 * `{ "mode": "fun-facts" }`. Python ignores fields it doesn't know
 * about, so adding the second field is back-compat.
 *
 * Semantics of urlOrTopic depend on `mode`:
 *   - news → narrows the headline pool ("AI safety", "tech")
 *   - youtube → preferred video URL the user named
 *   - fun-facts → topic hint passed to the trivia source
 *   - calendar → range hint ("today", "this week")
 *   - quiet / hum / off → ignored
 */

export type FillerMode =
  | "news"
  | "youtube"
  | "hum"
  | "off"
  | "fun-facts"
  | "calendar"
  | "quiet";

export const FILLER_MODES: readonly FillerMode[] = [
  "news",
  "fun-facts",
  "calendar",
  "quiet",
  "youtube",
  "hum",
  "off",
];
// Fresh installs land on fun-facts — friendlier than headlines for
// the typical thinking-time gap. Existing filler-config.json values
// override this (the file is read on every getFillerMode call).
export const DEFAULT_MODE: FillerMode = "fun-facts";

/** Modes whose content is fetched from /api/spar/filler-content and
 *  spoken via the dashboard's TTS. The Python pre-rendered clip
 *  pipeline handles "news" / "youtube" / "hum" / "off"; the items
 *  below are dashboard-native. */
export const TTS_CONTENT_MODES: readonly FillerMode[] = [
  "fun-facts",
  "calendar",
];

const CONFIG_PATH = path.resolve(
  process.cwd(),
  "telegram-voice",
  "filler-config.json",
);

function normalise(raw: unknown): FillerMode {
  if (typeof raw !== "string") return DEFAULT_MODE;
  const trimmed = raw.trim();
  if ((FILLER_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as FillerMode;
  }
  // Legacy values from the earlier multi-kind era — treat as news.
  if (trimmed === "mixed") return "news";
  if (trimmed === "facts") return "fun-facts";
  return DEFAULT_MODE;
}

export interface FillerConfig {
  mode: FillerMode;
  /** Mode-specific freeform hint. Empty/undefined means "no hint —
   *  use the mode's defaults". See the file-level doc comment for
   *  per-mode semantics. */
  urlOrTopic?: string;
}

/**
 * Read the current mode + optional hint. Never throws — missing /
 * malformed all resolve to DEFAULT_MODE so the filler system always
 * has a coherent answer. Cheap (small JSON file on a local path)
 * so callers can hit this per request without caching.
 */
export async function getFillerConfig(): Promise<FillerConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      mode?: unknown;
      urlOrTopic?: unknown;
    };
    const hint =
      typeof parsed.urlOrTopic === "string" && parsed.urlOrTopic.trim()
        ? parsed.urlOrTopic.trim()
        : undefined;
    return { mode: normalise(parsed.mode), urlOrTopic: hint };
  } catch {
    return { mode: DEFAULT_MODE };
  }
}

/** Back-compat shim — older callers only want the mode. */
export async function getFillerMode(): Promise<FillerMode> {
  const { mode } = await getFillerConfig();
  return mode;
}

/**
 * Write the mode (and optionally a freeform hint). Preserves
 * back-compat: when no hint is supplied the file stays the
 * single-key `{ "mode": ... }` shape that Python expects.
 */
export async function setFillerMode(
  mode: FillerMode,
  urlOrTopic?: string,
): Promise<void> {
  if (!(FILLER_MODES as readonly string[]).includes(mode)) {
    throw new Error(`invalid mode: ${mode}`);
  }
  const hint =
    typeof urlOrTopic === "string" && urlOrTopic.trim()
      ? urlOrTopic.trim()
      : undefined;
  const body: FillerConfig = hint ? { mode, urlOrTopic: hint } : { mode };
  await writeFile(
    CONFIG_PATH,
    JSON.stringify(body, null, 2),
    { encoding: "utf-8" },
  );
}
