"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ListMusic,
  Loader,
  Mic,
  Music,
  Newspaper,
  Pause,
  Phone,
  Play,
  Radio,
  SkipForward,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  Wind,
  X,
} from "lucide-react";
import { useSpar } from "./SparContext";
import type { FillerNow, YoutubeQueueItem } from "./SparContext";

const HIDDEN_KEY = "spar:miniPlayerHidden:v1";

export default function SparMiniPlayer() {
  const {
    fillerNow,
    youtubeQueue,
    youtubeVolume,
    setYoutubeVolume,
    youtubePlay,
    youtubePause,
    youtubeSkip,
    youtubeStop,
    youtubeClearQueue,
    youtubeRemoveFromQueue,
    youtubeReorderQueue,
  } = useSpar();

  const [volumeOpen, setVolumeOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Hidden = the player has been dismissed by the user. Renders as a
  // tiny restore tab on the left edge instead of the full card. Persist
  // to localStorage so the choice survives a reload — the dashboard
  // shouldn't keep popping the panel back up after the user closed it.
  const [hidden, setHidden] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setHidden(window.localStorage.getItem(HIDDEN_KEY) === "1");
    } catch {
      /* localStorage may be blocked; default to visible */
    }
  }, []);
  const setHiddenPersisted = (value: boolean) => {
    setHidden(value);
    if (typeof window === "undefined") return;
    try {
      if (value) window.localStorage.setItem(HIDDEN_KEY, "1");
      else window.localStorage.removeItem(HIDDEN_KEY);
    } catch {
      /* ignore — in-memory state still flips */
    }
  };
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Track the last non-zero volume so the mute toggle restores a
  // sensible level — without this, hitting unmute after dragging the
  // slider to zero would bounce right back to zero.
  const lastNonZeroRef = useRef<number>(youtubeVolume > 0 ? youtubeVolume : 80);
  useEffect(() => {
    if (youtubeVolume > 0) lastNonZeroRef.current = youtubeVolume;
  }, [youtubeVolume]);

  const muted = youtubeVolume === 0;
  const handleMuteToggle = () => {
    if (muted) {
      setYoutubeVolume(lastNonZeroRef.current || 80);
    } else {
      setYoutubeVolume(0);
    }
  };

  const isYoutube = fillerNow.kind === "youtube";
  const isPlayingYt = isYoutube && fillerNow.status === "playing";
  const ytThumb = isYoutube ? thumbForFiller(fillerNow) : null;
  const ytTitle = isYoutube ? fillerNow.title : null;

  // Click-outside collapse so a casual click anywhere on the page
  // closes the expanded card. Only attached while expanded — listening
  // unconditionally would be wasteful.
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      const root = containerRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      setExpanded(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expanded]);

  // Auto-collapse when the now-playing track switches off YouTube
  // (e.g. user hit stop, or the queue ran dry). Leaving the expanded
  // card up showing a "nothing playing" art slot is jarring.
  useEffect(() => {
    if (!isYoutube) setExpanded(false);
  }, [isYoutube]);

  const handleNowPlayingClick = () => {
    if (!isYoutube) return;
    setExpanded((v) => !v);
  };

  // Auto-hide: when nothing is happening AND the queue is empty, the
  // mini-player has nothing useful to render — drop it entirely
  // (including the restore tab — there's nothing to restore TO). The
  // moment a track plays, the queue grows, or any non-idle filler
  // state lights up (telegram phase, thinking, listening, etc.), this
  // gate flips and the player re-appears.
  //
  // Deliberately gated on `kind === "idle"` rather than just
  // `!isYoutube` because the player also serves as the live filler
  // status indicator — hiding it during a Telegram call or thinking
  // window would lose that signal. Idle means the SparProvider
  // priority chain found nothing audible AND nothing pending; only
  // then is "no UI" the right call.
  if (fillerNow.kind === "idle" && youtubeQueue.length === 0) {
    return null;
  }

  // Hidden state: render a tiny restore tab on the bottom-left edge.
  // Visual is intentionally minimal — a single rounded icon button —
  // so a dismissed player isn't visually intrusive but is one click
  // from coming back. Doesn't render the queue ExpandedCard at all.
  if (hidden) {
    return (
      // Mobile: sit above the call dock + input form (~140px tall) so
      // the restore tab doesn't cover the type-here field. Desktop:
      // bottom-4 since the dock is comfortably narrower than the
      // viewport and there's no overlap.
      <div className="pointer-events-auto fixed bottom-44 left-4 z-30 sm:bottom-4">
        <button
          type="button"
          onClick={() => setHiddenPersisted(false)}
          aria-label="show audio player"
          title="show audio player"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900/85 text-neutral-300 shadow-[0_8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md transition hover:bg-neutral-800 hover:text-neutral-100"
        >
          {isYoutube ? (
            <Music className="h-4 w-4" />
          ) : (
            <ListMusic className="h-4 w-4" />
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      // Mobile: lifted to bottom-44 (~176px) so the opaque card sits
      // ABOVE the call dock + input form instead of covering them.
      // Desktop: bottom-4 since the dock is centered and narrower than
      // the viewport — no collision with the 300px-wide player.
      className="pointer-events-auto fixed bottom-44 left-4 z-30 w-[300px] max-w-[calc(100vw-2rem)] sm:bottom-4"
    >
      {expanded && isYoutube && (
        <ExpandedCard
          thumbnailUrl={ytThumb}
          title={ytTitle}
          status={fillerNow.status}
          queue={youtubeQueue}
          onClose={() => setExpanded(false)}
          onStop={() => {
            // Collapse first so the next render — which sees idle
            // state — doesn't briefly show a stale "now playing"
            // tile before the auto-hide gate kicks in.
            setExpanded(false);
            youtubeStop();
          }}
          onClearQueue={youtubeClearQueue}
          onRemove={youtubeRemoveFromQueue}
          onReorder={youtubeReorderQueue}
        />
      )}
      <div className="flex items-center gap-3 rounded-2xl border border-neutral-800 bg-neutral-900/85 px-2.5 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md">
        <button
          type="button"
          onClick={handleNowPlayingClick}
          disabled={!isYoutube}
          className={`flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left transition ${
            isYoutube
              ? "cursor-pointer hover:bg-neutral-800/40"
              : "cursor-default"
          }`}
          aria-label={isYoutube ? (expanded ? "collapse player" : "expand player") : undefined}
          aria-expanded={isYoutube ? expanded : undefined}
        >
          <ArtSlot fillerNow={fillerNow} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[12px] leading-tight font-medium text-neutral-100">
              {primaryLabel(fillerNow)}
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
              {secondaryLabel(fillerNow, youtubeQueue.length)}
            </span>
          </div>
        </button>
        <div className="flex items-center gap-0.5">
          {isYoutube ? (
            <>
              <IconButton
                label={isPlayingYt ? "pause" : "play"}
                onClick={isPlayingYt ? youtubePause : youtubePlay}
              >
                {isPlayingYt ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </IconButton>
              <IconButton label="skip" onClick={youtubeSkip}>
                <SkipForward className="h-4 w-4" />
              </IconButton>
              <div
                className="relative"
                onMouseEnter={() => setVolumeOpen(true)}
                onMouseLeave={() => setVolumeOpen(false)}
              >
                <IconButton
                  label={muted ? "unmute" : "mute"}
                  onClick={handleMuteToggle}
                  onFocus={() => setVolumeOpen(true)}
                  onBlur={() => setVolumeOpen(false)}
                >
                  {muted ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </IconButton>
                {volumeOpen && (
                  <div
                    className="absolute right-0 bottom-full mb-2 flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/95 px-3 py-1.5 shadow-lg"
                    onMouseEnter={() => setVolumeOpen(true)}
                    onMouseLeave={() => setVolumeOpen(false)}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={youtubeVolume}
                      onChange={(e) => setYoutubeVolume(Number(e.target.value))}
                      aria-label="volume"
                      className="amaso-mini-slider h-1 w-28 cursor-pointer appearance-none rounded-full bg-neutral-700 outline-none"
                    />
                    <span className="w-7 text-right font-mono text-[10px] tabular-nums text-neutral-400">
                      {youtubeVolume}
                    </span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <ActivityDot fillerNow={fillerNow} />
          )}
          <IconButton
            label="hide player"
            onClick={() => {
              setExpanded(false);
              setHiddenPersisted(true);
            }}
          >
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <style jsx>{`
        .amaso-mini-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 9999px;
          background: rgb(229 229 229);
          border: 0;
          cursor: pointer;
        }
        .amaso-mini-slider::-moz-range-thumb {
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

function ExpandedCard({
  thumbnailUrl,
  title,
  status,
  queue,
  onClose,
  onStop,
  onClearQueue,
  onRemove,
  onReorder,
}: {
  thumbnailUrl: string | null;
  title: string | null;
  status: "playing" | "paused";
  queue: YoutubeQueueItem[];
  onClose: () => void;
  onStop: () => void;
  onClearQueue: () => void;
  onRemove: (videoId: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
}) {
  return (
    <div
      className="mb-2 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/95 shadow-[0_12px_40px_rgba(0,0,0,0.7)] backdrop-blur-md"
      role="dialog"
      aria-label="now playing"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-neutral-950">
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={title ?? "now playing"}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-neutral-700">
            <Music className="h-10 w-10" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
        <div className="absolute right-2 top-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            title="close"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-neutral-300 backdrop-blur transition hover:bg-black/70 hover:text-neutral-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="absolute inset-x-3 bottom-2 flex items-end justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-300/80">
              {status === "playing" ? "now playing" : "paused"}
            </div>
            <div className="mt-0.5 line-clamp-2 text-[13px] font-medium leading-tight text-neutral-50">
              {title ?? "Untitled video"}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-neutral-500">
          <ListMusic className="h-3.5 w-3.5" />
          <span>
            up next ·{" "}
            <span className="font-mono text-neutral-300">{queue.length}</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          {queue.length > 0 && (
            <button
              type="button"
              onClick={onClearQueue}
              className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
            >
              clear
            </button>
          )}
          {/* Stop is the destructive end-this action: clears the
              now-playing selection AND wipes any queue, returning
              the filler mode to news. Distinct from the X close
              button on the thumbnail (which only collapses the
              card) and from clear (which leaves now-playing intact). */}
          <button
            type="button"
            onClick={onStop}
            aria-label="stop playback"
            title="stop playback"
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-rose-300 transition hover:bg-rose-900/30 hover:text-rose-100"
          >
            <Square className="h-3 w-3" />
            stop
          </button>
        </div>
      </div>
      <div className="max-h-[260px] overflow-y-auto px-2 pb-2">
        {queue.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-neutral-500">
            <ChevronDown className="h-3.5 w-3.5 opacity-40" />
            <span>Queue is empty.</span>
          </div>
        ) : (
          <ul className="flex flex-col">
            {queue.map((item, idx) => {
              const canMoveUp = idx > 0;
              const canMoveDown = idx < queue.length - 1;
              return (
                <li
                  key={`${item.videoId}-${idx}`}
                  className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-800/40"
                >
                  <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-600">
                    {idx + 1}
                  </span>
                  <QueueArt item={item} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px] leading-tight text-neutral-200">
                      {item.title ?? item.videoId}
                    </span>
                    <span className="text-[10px] text-neutral-500">
                      {formatDuration(item.durationSec)}
                    </span>
                  </div>
                  {/* Per-row controls. Hidden until row hover/focus so
                      the resting state stays clean — keyboard users still
                      get focus-visible outlines because the buttons are
                      tab-reachable, just visually de-emphasised at rest. */}
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

function QueueArt({ item }: { item: YoutubeQueueItem }) {
  const url =
    item.thumbnailUrl ??
    `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
  return (
    <div className="relative h-9 w-14 shrink-0 overflow-hidden rounded bg-neutral-800">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={item.title ?? "queued track"}
        className="h-full w-full object-cover"
        loading="lazy"
      />
    </div>
  );
}

function formatDuration(durationSec: number | null): string {
  if (!durationSec || durationSec <= 0) return "—";
  const m = Math.floor(durationSec / 60);
  const s = Math.floor(durationSec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function thumbForFiller(
  fillerNow: Extract<FillerNow, { kind: "youtube" }>,
): string | null {
  if (fillerNow.thumbnailUrl) return fillerNow.thumbnailUrl;
  if (fillerNow.videoId) {
    return `https://i.ytimg.com/vi/${fillerNow.videoId}/hqdefault.jpg`;
  }
  return null;
}

function ArtSlot({ fillerNow }: { fillerNow: FillerNow }) {
  if (fillerNow.kind === "youtube") {
    const thumb = thumbForFiller(fillerNow);
    if (thumb) {
      return (
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-neutral-800">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumb}
            alt={fillerNow.title ?? "now playing"}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </div>
      );
    }
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-neutral-800 text-neutral-500">
        <Music className="h-5 w-5" />
      </div>
    );
  }
  // Non-YouTube art: kind-appropriate icon on a soft tint. Telegram's
  // visual swaps in based on phase so the user can read the call's
  // live state at a glance instead of a static phone glyph.
  const { icon: Icon, tint } = artForFiller(fillerNow);
  const animate =
    fillerNow.kind === "thinking" ||
    fillerNow.kind === "speaking" ||
    fillerNow.kind === "listening" ||
    fillerNow.kind === "news" ||
    fillerNow.kind === "telegram";
  return (
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${tint}`}
    >
      <Icon className={`h-5 w-5 ${animate ? "animate-pulse" : ""}`} />
    </div>
  );
}

function ActivityDot({ fillerNow }: { fillerNow: FillerNow }) {
  if (fillerNow.kind === "idle") {
    return (
      <span className="px-2 text-[10px] uppercase tracking-[0.18em] text-neutral-600">
        —
      </span>
    );
  }
  if (fillerNow.kind === "thinking") {
    return (
      <Loader className="h-4 w-4 animate-spin text-neutral-400" aria-label="thinking" />
    );
  }
  if (fillerNow.kind === "telegram" && fillerNow.phase === "thinking") {
    return (
      <Loader
        className="h-4 w-4 animate-spin text-sky-300"
        aria-label="telegram thinking"
      />
    );
  }
  if (fillerNow.kind === "telegram") {
    // Live tag is colour-shifted by phase so a glance at the badge
    // tells you whether the assistant is talking or listening on the
    // phone leg.
    const phaseColor =
      fillerNow.phase === "speaking"
        ? "bg-emerald-400"
        : "bg-sky-300";
    const phaseText =
      fillerNow.phase === "speaking" ? "speaking" : "listening";
    return (
      <span className="mr-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-sky-300">
        <span className={`block h-1.5 w-1.5 animate-pulse rounded-full ${phaseColor}`} />
        {phaseText}
      </span>
    );
  }
  return (
    <span className="mr-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-neutral-400">
      <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-300" />
      live
    </span>
  );
}

function primaryLabel(fillerNow: FillerNow): string {
  switch (fillerNow.kind) {
    case "youtube":
      return fillerNow.title ?? "playing";
    case "news":
      return "Reading the news";
    case "hum":
      return "Windchime hum";
    case "speaking":
      return "Sparring partner speaking";
    case "listening":
      return "Listening…";
    case "thinking":
      return "Thinking…";
    case "telegram":
      switch (fillerNow.phase) {
        case "thinking":
          return "Telegram · thinking…";
        case "speaking":
          return "Telegram · speaking";
        case "listening":
          return "Telegram · listening…";
      }
    // eslint-disable-next-line no-fallthrough
    case "idle":
      return "Nothing playing";
  }
}

function secondaryLabel(fillerNow: FillerNow, queueLength: number): string {
  switch (fillerNow.kind) {
    case "youtube": {
      const base = fillerNow.status === "playing" ? "now playing" : "paused";
      if (queueLength > 0) {
        return `${base} · +${queueLength} queued`;
      }
      return base;
    }
    case "news":
      return "filler · news clip";
    case "hum":
      return "filler · ambient";
    case "speaking":
      return "tts · live";
    case "listening":
      return "voice · live";
    case "thinking":
      return "claude · working";
    case "telegram":
      switch (fillerNow.phase) {
        case "thinking":
          return "phone · claude working";
        case "speaking":
          return "phone · assistant talking";
        case "listening":
          return "phone · mic open";
      }
    // eslint-disable-next-line no-fallthrough
    case "idle":
      return "ready";
  }
}

// Phase-aware art for the active filler. Telegram swaps icon + tint by
// phase so the badge is a true live-state indicator: a stable phone
// glyph would read as a bug ("what's the call doing right now?").
function artForFiller(fillerNow: Exclude<FillerNow, { kind: "youtube" }>): {
  icon: React.ComponentType<{ className?: string }>;
  tint: string;
} {
  switch (fillerNow.kind) {
    case "news":
      return { icon: Newspaper, tint: "bg-amber-900/30 text-amber-200" };
    case "hum":
      return { icon: Wind, tint: "bg-sky-900/30 text-sky-200" };
    case "speaking":
      return { icon: Radio, tint: "bg-emerald-900/30 text-emerald-200" };
    case "listening":
      return { icon: Mic, tint: "bg-rose-900/30 text-rose-200" };
    case "thinking":
      return { icon: Sparkles, tint: "bg-violet-900/30 text-violet-200" };
    case "telegram":
      switch (fillerNow.phase) {
        case "thinking":
          return {
            icon: Sparkles,
            tint: "bg-violet-900/30 text-violet-200",
          };
        case "speaking":
          return {
            icon: Radio,
            tint: "bg-emerald-900/30 text-emerald-200",
          };
        case "listening":
          return {
            icon: Phone,
            tint: "bg-sky-900/30 text-sky-200",
          };
      }
    // eslint-disable-next-line no-fallthrough
    case "idle":
      return { icon: Music, tint: "bg-neutral-800 text-neutral-500" };
  }
}

function IconButton({
  children,
  onClick,
  label,
  onFocus,
  onBlur,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
    >
      {children}
    </button>
  );
}

// Smaller variant used for per-queue-row reorder/remove. Sized down
// (h-6 w-6) so three of them sit comfortably to the right of the
// thumbnail without crowding the title. Disabled state is a true
// disabled button so keyboard nav skips it at the endpoints.
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
