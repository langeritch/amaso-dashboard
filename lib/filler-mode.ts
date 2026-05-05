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
 *   "fun-facts" — curated trivia spoken via the dashboard's TTS.
 *                 Sourced from `lib/filler-content/`.
 *   "calendar"  — upcoming items from the user's heartbeat / agenda,
 *                 spoken via TTS.
 *   "quiet"     — just the ambient windchime, no spoken content.
 *   "youtube"   — YouTube iframe plays on the dashboard during
 *                 thinking; Telegram falls back to news clips.
 *
 * Legacy "off" mode is no longer user-selectable — silencing the
 * assistant entirely now goes through the per-client TTS toggle in
 * SparContext. Persisted "off" values from older filler-config.json
 * files are normalised to "quiet" on read so behaviour stays sane
 * across the upgrade.
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
 *   - quiet → ignored
 */

export type FillerMode =
  | "news"
  | "youtube"
  | "fun-facts"
  | "calendar"
  | "quiet";

export const FILLER_MODES: readonly FillerMode[] = [
  "news",
  "fun-facts",
  "calendar",
  "quiet",
  "youtube",
];

/**
 * Modes the user is allowed to pick directly (dropdown / API). "youtube"
 * is intentionally excluded — it activates automatically when a video
 * starts and deactivates when playback ends, restoring whatever mode
 * was set before. Use enableYouTubeMode / disableYouTubeMode for that
 * transition; never POST `mode:"youtube"` to /api/spar/filler-mode.
 */
export const USER_SELECTABLE_MODES: readonly Exclude<FillerMode, "youtube">[] = [
  "news",
  "fun-facts",
  "calendar",
  "quiet",
];
// Fresh installs land on quiet — silence by default, the user opts
// into news / fun-facts explicitly. Existing filler-config.json
// values override this (the file is read on every getFillerMode call).
// Typed to the user-selectable subset so disableYouTubeMode can use
// it as a fallback for previousMode without a cast — the default is
// never "youtube" by definition.
export const DEFAULT_MODE: Exclude<FillerMode, "youtube"> = "quiet";

/** Modes whose content is fetched from /api/spar/filler-content and
 *  spoken via the dashboard's TTS. The Python pre-rendered clip
 *  pipeline handles "news" / "youtube"; the items below are
 *  dashboard-native. */
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
  // Legacy "hum" persisted on disk → its quiet alias.
  if (trimmed === "hum") return "quiet";
  // Legacy "off" mode (pre-TTS-toggle era) → quiet. Silencing the
  // assistant entirely now lives on the per-client TTS toggle, not
  // the persisted filler mode.
  if (trimmed === "off") return "quiet";
  return DEFAULT_MODE;
}

export interface FillerConfig {
  mode: FillerMode;
  /** Mode-specific freeform hint. Empty/undefined means "no hint —
   *  use the mode's defaults". See the file-level doc comment for
   *  per-mode semantics. */
  urlOrTopic?: string;
  /** Snapshot of the mode the user had set before "youtube" took over
   *  (i.e. before a video started playing). Restored verbatim by
   *  disableYouTubeMode when playback stops. Only meaningful when
   *  `mode === "youtube"` — cleared on any explicit user-driven
   *  setFillerMode call. Can never itself be "youtube"; the snapshot
   *  is the underlying user preference, not the override. */
  previousMode?: Exclude<FillerMode, "youtube">;
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
      previousMode?: unknown;
    };
    const hint =
      typeof parsed.urlOrTopic === "string" && parsed.urlOrTopic.trim()
        ? parsed.urlOrTopic.trim()
        : undefined;
    const prev = normaliseUserMode(parsed.previousMode);
    return {
      mode: normalise(parsed.mode),
      urlOrTopic: hint,
      previousMode: prev,
    };
  } catch {
    return { mode: DEFAULT_MODE };
  }
}

/** Normalise to a user-selectable mode (excludes "youtube"). Used for
 *  the previousMode field — that snapshot can never be "youtube"
 *  itself. Returns undefined for missing / malformed values. */
function normaliseUserMode(
  raw: unknown,
): Exclude<FillerMode, "youtube"> | undefined {
  const m = normalise(raw);
  if (m === "youtube") return undefined;
  return m;
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
 *
 * An explicit user-driven setFillerMode CLEARS any previousMode
 * snapshot — picking "news" while YouTube was playing means the user
 * wants news next, not "restore whatever I had before YouTube." The
 * automatic enable/disableYouTubeMode helpers are the only places that
 * preserve the snapshot.
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

/**
 * Switch into "youtube" mode automatically because a video started
 * playing. Snapshots the current mode into `previousMode` so we can
 * put it back when playback ends. Idempotent: calling this while
 * already in youtube mode preserves the existing snapshot rather than
 * overwriting it with "youtube" itself.
 */
export async function enableYouTubeMode(): Promise<void> {
  const current = await getFillerConfig();
  // Already in youtube mode — keep the existing previousMode snapshot
  // (or leave it empty if there's none); never replace it with
  // "youtube" because that would defeat the restore on next stop.
  if (current.mode === "youtube") {
    return;
  }
  const previousMode: Exclude<FillerMode, "youtube"> = current.mode;
  const body: FillerConfig = { mode: "youtube", previousMode };
  // Mode-specific hint doesn't carry across the youtube override —
  // when we restore, the user's prior hint is gone. That matches how
  // the dashboard already treats hints (per-mode, not persistent
  // beyond a fresh setFillerMode), and keeps the JSON small.
  await writeFile(
    CONFIG_PATH,
    JSON.stringify(body, null, 2),
    { encoding: "utf-8" },
  );
}

/**
 * Restore the user's pre-YouTube mode after playback ends. Reads the
 * `previousMode` snapshot and writes it back. Falls back to
 * DEFAULT_MODE if nothing was snapshotted (e.g. process restarted
 * mid-playback). Idempotent: if mode isn't currently "youtube" this
 * is a no-op so an extra stop event doesn't yank the user out of a
 * mode they actively picked.
 */
export async function disableYouTubeMode(): Promise<void> {
  const current = await getFillerConfig();
  if (current.mode !== "youtube") {
    return;
  }
  const restored: Exclude<FillerMode, "youtube"> =
    current.previousMode ?? DEFAULT_MODE;
  const body: FillerConfig = { mode: restored };
  await writeFile(
    CONFIG_PATH,
    JSON.stringify(body, null, 2),
    { encoding: "utf-8" },
  );
}
