"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Globe,
  Link2,
  Loader,
  Music,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useSpar } from "./SparContext";
import {
  mediaSourcesByType,
  type MediaSearchResult,
  type MediaSourceContext,
  type SearchMediaSource,
  type ToggleMediaSource,
  type UrlMediaSource,
} from "@/lib/media-sources";
import {
  getYoutubeCurrentTime,
  seekYoutube,
} from "@/lib/youtube-player-handle";

/**
 * Slide-up drawer mounted above the chat input. Hosts the full media
 * control surface — search, paste-a-URL, scrubber, queue, filler-mode
 * quick-toggles. Driven by the central registry in lib/media-sources;
 * drawer code never references concrete source ids, only types.
 *
 * Open/close is owned by the parent (SparMiniPlayer pill toggles it).
 * The drawer doesn't fetch anything until it's first opened — search
 * results are state-local and discarded on close, so reopening starts
 * fresh.
 */

const FILLER_MODE_POLL_MS = 5_000;
const SCRUBBER_TICK_MS = 200;

interface MediaDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function MediaDrawer({ open, onClose }: MediaDrawerProps) {
  const {
    fillerNow,
    youtubeNowPlaying,
    youtubeQueue,
    youtubeRemoveFromQueue,
    youtubeReorderQueue,
    youtubeEnqueue,
    youtubeStop,
    youtubePlay,
    youtubePause,
    appendNotice,
    ttsMuted,
    toggleTtsMute,
    inCall,
  } = useSpar();

  // Tracks whether muting TTS auto-paused a playing YouTube clip, so
  // unmuting can resume it. Mirrors the wrapper that used to live in
  // SparFullView.handleSpeakerToggle — moved here once the footer's
  // duplicate speaker button was removed.
  const ttsPausedYoutubeRef = useRef(false);
  const handleTtsToggle = useCallback(() => {
    const willMute = !ttsMuted;
    if (willMute) {
      if (fillerNow.kind === "youtube" && fillerNow.status === "playing") {
        ttsPausedYoutubeRef.current = true;
        youtubePause();
      }
    } else if (ttsPausedYoutubeRef.current) {
      ttsPausedYoutubeRef.current = false;
      youtubePlay();
    }
    toggleTtsMute();
  }, [ttsMuted, fillerNow, youtubePause, youtubePlay, toggleTtsMute]);

  // Polled filler mode + the snapshot of what the user had set before
  // YouTube took over. previousMode is what the dropdown should
  // highlight when mode==="youtube" — that's the underlying user
  // preference, restored automatically when playback ends.
  const [fillerMode, setFillerMode] = useState<string | null>(null);
  const [previousMode, setPreviousMode] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/spar/filler-mode", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          mode?: string;
          previousMode?: string;
        };
        if (!cancelled) {
          if (typeof data.mode === "string") setFillerMode(data.mode);
          setPreviousMode(
            typeof data.previousMode === "string" ? data.previousMode : null,
          );
        }
      } catch {
        /* ignore — next tick retries */
      }
    };
    void poll();
    const id = window.setInterval(poll, FILLER_MODE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open]);

  // What the dropdown should display: the user's actual selection. When
  // YouTube has auto-taken over (mode==="youtube"), surface the
  // previousMode snapshot so the dropdown shows the mode that will
  // resume after playback — never "youtube", which isn't selectable.
  const effectiveMode =
    fillerMode === "youtube" ? previousMode ?? null : fillerMode;

  // Article-URL TTS playback: a single Audio element reused across
  // multiple paste-and-reads so the user can swap articles without
  // a stale element lingering. Cleaned on drawer close + unmount.
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const [ttsState, setTtsState] = useState<"idle" | "loading" | "playing">(
    "idle",
  );
  const stopTtsAudio = useCallback(() => {
    const el = ttsAudioRef.current;
    if (!el) return;
    try {
      el.pause();
      el.src = "";
    } catch {
      /* ignore */
    }
    ttsAudioRef.current = null;
    setTtsState("idle");
  }, []);
  useEffect(() => {
    if (!open) stopTtsAudio();
  }, [open, stopTtsAudio]);
  useEffect(() => {
    return () => stopTtsAudio();
  }, [stopTtsAudio]);

  const speakUrl = useCallback(
    async (url: string) => {
      stopTtsAudio();
      setTtsState("loading");
      let res: Response;
      try {
        res = await fetch("/api/tts/url-read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
      } catch (err) {
        setTtsState("idle");
        appendNotice(`URL read failed: ${String(err).slice(0, 100)}`);
        return;
      }
      if (!res.ok) {
        const msg = await res.text().catch(() => `${res.status}`);
        setTtsState("idle");
        appendNotice(`URL read failed: ${msg.slice(0, 120)}`);
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      audio.addEventListener("ended", () => {
        URL.revokeObjectURL(objectUrl);
        setTtsState("idle");
        ttsAudioRef.current = null;
      });
      audio.addEventListener("error", () => {
        URL.revokeObjectURL(objectUrl);
        setTtsState("idle");
        ttsAudioRef.current = null;
      });
      ttsAudioRef.current = audio;
      try {
        await audio.play();
        setTtsState("playing");
      } catch {
        setTtsState("idle");
      }
      const truncated = res.headers.get("X-Amaso-Truncated") === "1";
      if (truncated) {
        const chars = res.headers.get("X-Amaso-Read-Chars") ?? "?";
        appendNotice(`Reading article (first ${chars} chars).`);
      } else {
        appendNotice(`Reading article.`);
      }
    },
    [appendNotice, stopTtsAudio],
  );

  // Apply a filler mode through the existing endpoint. Optimistic
  // update so the toggle highlights immediately; the next poll will
  // settle the truth.
  const applyFillerMode = useCallback(async (mode: string) => {
    setFillerMode(mode);
    try {
      await fetch("/api/spar/filler-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    } catch {
      /* ignore — poll re-syncs */
    }
  }, []);

  // Bundle for source callbacks. Memoised on the dependency set the
  // sources can reach for — recreating it on every render would
  // detach in-flight search dispatches.
  const sourceCtx = useMemo<MediaSourceContext>(
    () => ({
      enqueueYoutube: (item) => youtubeEnqueue(item),
      setFillerMode: applyFillerMode,
      currentFillerMode: fillerMode,
      speakUrl,
      appendNotice,
    }),
    [applyFillerMode, appendNotice, fillerMode, speakUrl, youtubeEnqueue],
  );

  // The drawer is rendered as a sibling of the pill so it slides up
  // BEHIND it (z-stack: pill > drawer). Pointer-events-none on the
  // backdrop element while closed so clicks elsewhere on the page
  // aren't intercepted.
  return (
    <div
      // Absolute-positioned overlay so the drawer floats ABOVE its
      // anchor (legacy pill or SparMediaRow's relative wrapper)
      // without consuming any layout space when closed. Earlier this
      // was an in-flow block, which silently inflated the unified
      // footer row to ~250px tall — the now-playing pill and the
      // composer ended up looking stacked on different rows.
      className={`pointer-events-none absolute bottom-full left-0 z-40 transition-all duration-200 ease-out ${
        open
          ? "translate-y-0 opacity-100"
          : "translate-y-3 opacity-0"
      }`}
      aria-hidden={!open}
    >
      <div
        role="dialog"
        aria-label="media controls"
        // Width matches the pill (300px) so the drawer feels like the
        // pill's underlay, not a separate panel. max-w prevents it
        // overflowing on narrow viewports.
        className={`pointer-events-auto mb-2 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/95 shadow-[0_12px_40px_rgba(0,0,0,0.7)] backdrop-blur-md ${
          open ? "" : "pointer-events-none"
        }`}
      >
        <DrawerHeader onClose={onClose} />
        <ScrubberSection
          fillerKind={fillerNow.kind}
          fillerTitle={fillerNowTitle(fillerNow)}
          ytStatus={youtubeNowPlaying.status}
          ytDurationSec={youtubeNowPlaying.durationSec}
          ytPositionSec={youtubeNowPlaying.positionSec}
        />
        <SectionDivider />
        <SearchSection ctx={sourceCtx} />
        <SectionDivider />
        <UrlPasteSection ctx={sourceCtx} ttsState={ttsState} onStopTts={stopTtsAudio} />
        <SectionDivider />
        <QueueSection
          queue={youtubeQueue}
          onRemove={youtubeRemoveFromQueue}
          onReorder={youtubeReorderQueue}
          onStopAll={() => {
            youtubeStop();
          }}
        />
        <SectionDivider />
        <TtsToggleRow
          muted={ttsMuted}
          inCall={inCall}
          onToggle={handleTtsToggle}
        />
        <SectionDivider />
        <FillerModeRow
          ctx={sourceCtx}
          activeMode={effectiveMode}
          onApply={applyFillerMode}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TTS speak/silence toggle
// ---------------------------------------------------------------------------

/**
 * Persisted on/off switch for the assistant's text-mode TTS. While
 * `inCall` is true the toggle is forced on (the call leg owns the
 * audio path) — we surface that with a locked visual + tooltip so
 * users understand why hitting the button does nothing mid-call.
 */
function TtsToggleRow({
  muted,
  inCall,
  onToggle,
}: {
  muted: boolean;
  inCall: boolean;
  onToggle: () => void;
}) {
  const lockedOn = inCall;
  // While in a call the underlying preference is moot — the audio
  // path always speaks. Render the button as ON and disable it so
  // the visual matches the actual behavior.
  const ttsOn = lockedOn ? true : !muted;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
        TTS
      </span>
      <button
        type="button"
        onClick={onToggle}
        disabled={lockedOn}
        aria-pressed={ttsOn}
        aria-label={ttsOn ? "TTS on — tap to mute" : "TTS muted — tap to unmute"}
        title={
          lockedOn
            ? "TTS always on during a call"
            : ttsOn
              ? "Tap to mute TTS"
              : "Tap to unmute TTS"
        }
        className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.16em] transition disabled:cursor-not-allowed disabled:opacity-70 ${
          ttsOn
            ? "border-orange-400/40 bg-orange-400/10 text-orange-200 hover:bg-orange-400/15"
            : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
        }`}
      >
        {ttsOn ? (
          <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span>{ttsOn ? "On" : "Off"}</span>
      </button>
    </div>
  );
}

function fillerNowTitle(
  fillerNow: ReturnType<typeof useSpar>["fillerNow"],
): string | null {
  if (fillerNow.kind === "youtube") return fillerNow.title ?? null;
  if (fillerNow.kind === "news") return fillerNow.title ?? null;
  return null;
}

function DrawerHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
        media controls
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="close drawer"
        className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function SectionDivider() {
  return <div className="border-t border-neutral-800/60" />;
}

// ---------------------------------------------------------------------------
// Scrubber
// ---------------------------------------------------------------------------

interface ScrubberSectionProps {
  fillerKind: ReturnType<typeof useSpar>["fillerNow"]["kind"];
  fillerTitle: string | null;
  ytStatus: "playing" | "paused" | "idle";
  ytDurationSec: number | null;
  ytPositionSec: number;
}

/**
 * Live position display for the active media source.
 *
 * YouTube: reads from the global player handle every SCRUBBER_TICK_MS
 * for sub-second smoothness; falls back to the polled positionSec when
 * the handle isn't registered yet (mount race after refresh). Drag
 * commits via seekYoutube on release — sending a seek per pointermove
 * would burn through quota and confuse the player on a long drag.
 *
 * News: read-only progress is intentionally not surfaced — the news
 * playback path doesn't expose a seekable interface (WebAudio source
 * nodes are single-use; "seeking" means rebuilding from a buffer
 * offset). Section collapses to a compact "playing" indicator instead.
 */
function ScrubberSection({
  fillerKind,
  fillerTitle,
  ytStatus,
  ytDurationSec,
  ytPositionSec,
}: ScrubberSectionProps) {
  const isYoutube = fillerKind === "youtube";
  const [livePos, setLivePos] = useState<number>(ytPositionSec);
  const [draggingPos, setDraggingPos] = useState<number | null>(null);

  // Tick the live position from the player handle. Falling back to
  // the prop keeps the bar from snapping to 0 during the brief mount
  // window before the YT player publishes its handle.
  useEffect(() => {
    if (!isYoutube) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const handlePos = getYoutubeCurrentTime();
      setLivePos(handlePos != null ? handlePos : ytPositionSec);
    };
    tick();
    const id = window.setInterval(tick, SCRUBBER_TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [isYoutube, ytPositionSec]);

  if (!isYoutube) {
    // Non-YouTube media: tell the user what's playing without
    // pretending we have a draggable position bar for it.
    return (
      <div className="px-3 py-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
          now playing
        </div>
        <div className="mt-1 truncate text-[13px] text-neutral-200">
          {fillerTitle ?? labelForFillerKind(fillerKind)}
        </div>
      </div>
    );
  }

  const dur = ytDurationSec && ytDurationSec > 0 ? ytDurationSec : null;
  const pos = draggingPos ?? livePos;
  const sliderMax = dur ?? Math.max(60, Math.ceil(pos + 1));
  const disabled = ytStatus === "idle" || dur == null;

  return (
    <div className="px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] text-neutral-300">
          {fillerTitle ?? "Now playing"}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-500">
          {formatTime(pos)} / {dur ? formatTime(dur) : "—"}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={sliderMax}
        step={1}
        value={Math.min(sliderMax, Math.max(0, Math.floor(pos)))}
        disabled={disabled}
        onChange={(e) => setDraggingPos(Number(e.target.value))}
        onPointerUp={() => {
          if (draggingPos == null) return;
          seekYoutube(draggingPos);
          setDraggingPos(null);
        }}
        onKeyUp={() => {
          if (draggingPos == null) return;
          seekYoutube(draggingPos);
          setDraggingPos(null);
        }}
        aria-label="seek"
        className="amaso-scrubber mt-2 h-1 w-full cursor-pointer appearance-none rounded-full bg-neutral-700 outline-none disabled:cursor-not-allowed disabled:opacity-40"
      />
      <style jsx>{`
        .amaso-scrubber::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 9999px;
          background: rgb(229 229 229);
          border: 0;
          cursor: pointer;
        }
        .amaso-scrubber::-moz-range-thumb {
          width: 12px;
          height: 12px;
          border-radius: 9999px;
          background: rgb(229 229 229);
          border: 0;
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}

function labelForFillerKind(kind: string): string {
  switch (kind) {
    case "news":
      return "News headline";
    case "speaking":
      return "Sparring partner speaking";
    case "listening":
      return "Listening…";
    case "thinking":
      return "Thinking…";
    case "telegram":
      return "Telegram call";
    default:
      return "Nothing playing";
  }
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function SearchSection({ ctx }: { ctx: MediaSourceContext }) {
  const sources = useMemo(() => mediaSourcesByType("search"), []);
  const [activeId, setActiveId] = useState<string>(
    sources[0]?.id ?? "",
  );
  const active = sources.find((s) => s.id === activeId) ?? sources[0];
  if (!active) return null;
  return <SearchPicker source={active} ctx={ctx} />;
}

function SearchPicker({
  source,
  ctx,
}: {
  source: SearchMediaSource;
  ctx: MediaSourceContext;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Cancel an in-flight search if the user submits a new one before
  // the first finishes — the second result set should win even if the
  // first is slower. Tracked via a sequence number rather than
  // AbortController so we don't have to plumb signals through the
  // source's search() signature.
  const seqRef = useRef(0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const my = ++seqRef.current;
    setLoading(true);
    setErr(null);
    try {
      const r = await source.search(q);
      if (my !== seqRef.current) return;
      setResults(r);
      if (r.length === 0) setErr("No results.");
    } catch (e: unknown) {
      if (my !== seqRef.current) return;
      setErr(String(e).slice(0, 120));
      setResults([]);
    } finally {
      if (my === seqRef.current) setLoading(false);
    }
  };

  const Icon = source.icon;
  return (
    <div className="px-3 py-3">
      <form onSubmit={submit} className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={source.placeholder}
          aria-label={`${source.label} search`}
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-100 outline-none focus:border-neutral-600"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="rounded-md bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-900 transition disabled:opacity-40 hover:bg-white"
        >
          {loading ? "…" : "Go"}
        </button>
      </form>
      {err && (
        <div className="mt-2 text-[11px] text-rose-300/80">{err}</div>
      )}
      {results.length > 0 && (
        <ul className="mt-2 max-h-[200px] overflow-y-auto rounded-md border border-neutral-800/80">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  source.onSelect(r, ctx);
                }}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition hover:bg-neutral-800/40"
              >
                {r.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.thumbnailUrl}
                    alt=""
                    className="h-9 w-14 shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-9 w-14 shrink-0 items-center justify-center rounded bg-neutral-800 text-neutral-500">
                    <Music className="h-4 w-4" />
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] leading-tight text-neutral-200">
                    {r.title}
                  </span>
                  {r.subtitle && (
                    <span className="truncate text-[10px] text-neutral-500">
                      {r.subtitle}
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// URL paste
// ---------------------------------------------------------------------------

function UrlPasteSection({
  ctx,
  ttsState,
  onStopTts,
}: {
  ctx: MediaSourceContext;
  ttsState: "idle" | "loading" | "playing";
  onStopTts: () => void;
}) {
  const sources = useMemo(() => mediaSourcesByType("url"), []);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      setHint("Not a valid URL.");
      return;
    }
    const handler = pickUrlHandler(sources, url);
    if (!handler) {
      setHint("No handler matched.");
      return;
    }
    setHint(null);
    setBusy(true);
    try {
      await handler.handle(url, ctx);
      setValue("");
    } catch (err) {
      setHint(String(err).slice(0, 120));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 py-3">
      <form onSubmit={submit} className="flex items-center gap-2">
        <Link2 className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
        <input
          type="url"
          inputMode="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste a YouTube link or article URL…"
          aria-label="paste url"
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-100 outline-none focus:border-neutral-600"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="rounded-md bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-900 transition disabled:opacity-40 hover:bg-white"
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
      {hint && <div className="mt-2 text-[11px] text-rose-300/80">{hint}</div>}
      {ttsState !== "idle" && (
        <div className="mt-2 flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950/60 px-2 py-1.5 text-[11px] text-neutral-300">
          <span className="flex items-center gap-1.5">
            {ttsState === "loading" ? (
              <Loader className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{ttsState === "loading" ? "Fetching article…" : "Reading article"}</span>
          </span>
          {ttsState === "playing" && (
            <button
              type="button"
              onClick={onStopTts}
              className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              aria-label="stop"
              title="stop"
            >
              <Square className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function pickUrlHandler(
  sources: readonly UrlMediaSource[],
  url: URL,
): UrlMediaSource | null {
  for (const s of sources) {
    if (s.matches(url)) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

interface QueueSectionProps {
  queue: ReturnType<typeof useSpar>["youtubeQueue"];
  onRemove: (videoId: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onStopAll: () => void;
}

function QueueSection({
  queue,
  onRemove,
  onReorder,
  onStopAll,
}: QueueSectionProps) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
          queue · <span className="font-mono text-neutral-300">{queue.length}</span>
        </span>
        {queue.length > 0 && (
          <button
            type="button"
            onClick={onStopAll}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-rose-300 transition hover:bg-rose-900/30 hover:text-rose-100"
            aria-label="stop and clear queue"
            title="stop and clear queue"
          >
            <Square className="h-3 w-3" />
            stop
          </button>
        )}
      </div>
      <div className="max-h-[180px] overflow-y-auto px-2 pb-2">
        {queue.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-neutral-500">
            <ChevronDown className="h-3.5 w-3.5 opacity-40" aria-hidden="true" />
            <span>Queue is empty.</span>
          </div>
        ) : (
          <ul className="flex flex-col">
            {queue.map((item, idx) => {
              const canMoveUp = idx > 0;
              const canMoveDown = idx < queue.length - 1;
              const thumb =
                item.thumbnailUrl ??
                `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
              return (
                <li
                  key={`${item.videoId}-${idx}`}
                  className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-800/40"
                >
                  <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-600">
                    {idx + 1}
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumb}
                    alt=""
                    className="h-9 w-14 shrink-0 rounded bg-neutral-800 object-cover"
                    loading="lazy"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px] leading-tight text-neutral-200">
                      {item.title ?? item.videoId}
                    </span>
                    <span className="text-[10px] text-neutral-500">
                      {item.durationSec ? formatTime(item.durationSec) : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <RowButton
                      label="move up"
                      disabled={!canMoveUp}
                      onClick={() => onReorder(idx, idx - 1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </RowButton>
                    <RowButton
                      label="move down"
                      disabled={!canMoveDown}
                      onClick={() => onReorder(idx, idx + 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </RowButton>
                    <RowButton
                      label="remove"
                      onClick={() => onRemove(item.videoId)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </RowButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function RowButton({
  children,
  onClick,
  label,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-500"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Filler-mode toggles
// ---------------------------------------------------------------------------

function FillerModeRow({
  ctx,
  activeMode,
  onApply,
}: {
  ctx: MediaSourceContext;
  activeMode: string | null;
  onApply: (mode: string) => Promise<void>;
}) {
  const toggles = useMemo(() => mediaSourcesByType("toggle"), []);
  // Resolve which option matches the live mode (matchModes acts as
  // an alias set, e.g. "calendar" highlights the spoken toggle).
  // Defaults to "quiet" while activeMode is still null so the
  // dropdown never flashes on a non-existent option.
  const selectedMode = useMemo(() => {
    const match = toggles.find((t) => isToggleActive(t, activeMode));
    return match?.fillerMode ?? "quiet";
  }, [toggles, activeMode]);

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
        mode
      </span>
      <div className="relative ml-auto">
        <select
          value={selectedMode}
          onChange={(e) => {
            void onApply(e.target.value);
            void ctx;
          }}
          aria-label="filler mode"
          className="appearance-none rounded-md border border-neutral-700 bg-neutral-900 py-1 pl-2.5 pr-7 text-[10px] uppercase tracking-[0.16em] text-neutral-200 outline-none transition hover:border-neutral-600 focus:border-neutral-500"
        >
          {toggles.map((t) => (
            <option
              key={t.id}
              value={t.fillerMode}
              className="bg-neutral-900 text-neutral-200"
            >
              {t.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-500"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

function isToggleActive(
  toggle: ToggleMediaSource,
  activeMode: string | null,
): boolean {
  if (!activeMode) return false;
  if (toggle.fillerMode === activeMode) return true;
  return toggle.matchModes?.includes(activeMode) ?? false;
}

