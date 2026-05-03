"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
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
  Volume2,
  VolumeX,
} from "lucide-react";
import { useSpar } from "./SparContext";
import type { FillerNow } from "./SparContext";
import MediaDrawer from "./MediaDrawer";
import { useSparFooter } from "./SparFooterContext";
import YoutubePiPButton from "./YoutubePiPButton";

/**
 * Inner row content for the mini player — artwork + label + transport
 * controls (or a live-state activity dot when nothing is actively
 * playing). Renders the MediaDrawer and a small style block too. Owns
 * its own expand/volume-popover state so any consumer (the standalone
 * pill in SparMiniPlayer or a unified footer in SparFullView) can drop
 * it in without re-implementing the player logic.
 */
export function SparMediaRow({ compact = false }: { compact?: boolean }) {
  const {
    fillerNow,
    youtubeQueue,
    youtubeVolume,
    setYoutubeVolume,
    youtubePlay,
    youtubePause,
    youtubeSkip,
    newsUpcoming,
    newsPause,
    newsResume,
    newsSkip,
  } = useSpar();

  const [volumeOpen, setVolumeOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lastNonZeroRef = useRef<number>(youtubeVolume > 0 ? youtubeVolume : 80);
  useEffect(() => {
    if (youtubeVolume > 0) lastNonZeroRef.current = youtubeVolume;
  }, [youtubeVolume]);

  const muted = youtubeVolume === 0;
  const handleMuteToggle = () => {
    if (muted) setYoutubeVolume(lastNonZeroRef.current || 80);
    else setYoutubeVolume(0);
  };

  const isYoutube = fillerNow.kind === "youtube";
  const isNews = fillerNow.kind === "news";
  const isMedia = isYoutube || isNews;
  const isPlayingYt = isYoutube && fillerNow.status === "playing";
  const isPlayingNews = isNews && !fillerNow.paused;
  const isPlaying = isPlayingYt || isPlayingNews;

  const handleNowPlayingClick = () => setExpanded((v) => !v);
  const handlePlayPause = () => {
    if (isYoutube) {
      if (isPlayingYt) youtubePause();
      else youtubePlay();
      return;
    }
    if (isNews) {
      if (isPlayingNews) newsPause();
      else newsResume();
    }
  };
  const handleSkip = () => {
    if (isYoutube) youtubeSkip();
    else if (isNews) newsSkip();
  };

  return (
    <div className="relative flex min-w-0 items-center gap-1">
      <MediaDrawer open={expanded} onClose={() => setExpanded(false)} />
      <button
        type="button"
        onClick={handleNowPlayingClick}
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg text-left transition hover:bg-neutral-800/40"
        aria-label={expanded ? "close media drawer" : "open media drawer"}
        aria-expanded={expanded}
      >
        <ArtSlot fillerNow={fillerNow} compact={compact} />
        <div className="flex min-w-0 flex-col">
          <span
            className={
              compact
                ? "max-w-[10rem] truncate text-[11px] leading-tight font-medium text-neutral-100 sm:max-w-[18rem]"
                : "truncate text-[12px] leading-tight font-medium text-neutral-100"
            }
          >
            {primaryLabel(fillerNow)}
          </span>
          <span
            className={
              compact
                ? "hidden text-[9px] uppercase tracking-[0.18em] text-neutral-500 sm:block"
                : "text-[10px] uppercase tracking-[0.18em] text-neutral-500"
            }
          >
            {secondaryLabel(fillerNow, youtubeQueue.length, newsUpcoming.length)}
          </span>
        </div>
      </button>
      <div className="flex items-center gap-0.5">
        {isMedia ? (
          <>
            <IconButton
              label={isPlaying ? "pause" : "play"}
              onClick={handlePlayPause}
            >
              {isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </IconButton>
            <IconButton label="skip" onClick={handleSkip}>
              <SkipForward className="h-4 w-4" />
            </IconButton>
            {isYoutube && (
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
            )}
            <YoutubePiPButton />
          </>
        ) : (
          <ActivityDot fillerNow={fillerNow} />
        )}
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

export default function SparMiniPlayer() {
  const {
    fillerNow,
    youtubeQueue,
    youtubeVolume,
    setYoutubeVolume,
    youtubePlay,
    youtubePause,
    youtubeSkip,
    newsUpcoming,
    newsPause,
    newsResume,
    newsSkip,
  } = useSpar();

  const [volumeOpen, setVolumeOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // When a caller (currently SparFullView) claims the footer, the bar
  // stretches across the full bottom and exposes a right-side slot for
  // injected controls. Otherwise it renders as the standalone pill in
  // the bottom-left.
  const footerCtx = useSparFooter();
  const footerMode = footerCtx?.footerActive ?? false;
  const setSlotEl = footerCtx?.setSlotEl;
  const setFooterHeight = footerCtx?.setFooterHeight;
  const slotRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      if (setSlotEl) setSlotEl(el);
    },
    [setSlotEl],
  );

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
  const isNews = fillerNow.kind === "news";
  // Either YouTube or News surfaces the full transport controls
  // (play/pause/skip) and the expandable up-next card. Telegram /
  // speaking / listening / thinking / idle render the dot indicator
  // instead.
  const isMedia = isYoutube || isNews;
  const isPlayingYt = isYoutube && fillerNow.status === "playing";
  const isPlayingNews = isNews && !fillerNow.paused;
  const isPlaying = isPlayingYt || isPlayingNews;

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

  // The pill is always a drawer toggle now — even when nothing is
  // playing the user can open it to search for music or paste a URL.
  // We deliberately do NOT auto-collapse on media-state changes; the
  // drawer is the user's own modal and they decide when it goes away.
  const handleNowPlayingClick = () => {
    setExpanded((v) => !v);
  };

  // Unified play/pause dispatch — picks YouTube or News path based
  // on the current filler kind so the same button works for both.
  const handlePlayPause = () => {
    if (isYoutube) {
      if (isPlayingYt) youtubePause();
      else youtubePlay();
      return;
    }
    if (isNews) {
      if (isPlayingNews) newsPause();
      else newsResume();
    }
  };
  const handleSkip = () => {
    if (isYoutube) youtubeSkip();
    else if (isNews) newsSkip();
  };

  // The player serves as both a transport surface AND a live filler-
  // status indicator, so it stays visible on every authenticated page
  // — see app/layout.tsx, where it's mounted inside SparProvider and
  // therefore not rendered on /login or /setup (no user → no
  // provider). When `kind === "idle"` and the queue is empty the bar
  // collapses to a minimal "music · ready" pill; otherwise it expands
  // to the full transport. There is no user-dismissable hidden state
  // — the affordance must always be one click away.
  const idleEmpty = fillerNow.kind === "idle" && youtubeQueue.length === 0;

  // Publish the rendered footer's height as a CSS variable on the
  // document and into context so SparFullView can pad its bottom edge
  // dynamically. Hardcoding a fixed reserve let the bar overlap chat
  // inputs whenever portaled controls or the safe-area inset pushed
  // the footer above the assumed height.
  useEffect(() => {
    if (!footerMode) {
      document.documentElement.style.removeProperty("--spar-footer-h");
      if (setFooterHeight) setFooterHeight(0);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const publish = (h: number) => {
      const px = Math.ceil(h);
      document.documentElement.style.setProperty(
        "--spar-footer-h",
        `${px}px`,
      );
      if (setFooterHeight) setFooterHeight(px);
    };
    publish(el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // borderBoxSize includes border + padding so it matches the
        // visual footer height; fall back to contentRect when older
        // browsers don't expose it.
        const box = entry.borderBoxSize?.[0];
        const h = box ? box.blockSize : entry.contentRect.height;
        publish(h);
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--spar-footer-h");
      if (setFooterHeight) setFooterHeight(0);
    };
  }, [footerMode, setFooterHeight, idleEmpty]);

  if (footerMode) return null;

  if (idleEmpty) {
    if (footerMode) {
      return (
        <div
          ref={containerRef}
          className="pointer-events-auto pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-neutral-800 bg-neutral-900/85 backdrop-blur-md shadow-[0_-8px_24px_rgba(0,0,0,0.45)]"
        >
          <MediaDrawer open={expanded} onClose={() => setExpanded(false)} />
          <div className="mx-auto flex w-full items-center gap-2 px-3 py-1">
            <button
              type="button"
              onClick={handleNowPlayingClick}
              aria-label={expanded ? "close media drawer" : "open media drawer"}
              aria-expanded={expanded}
              className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left transition hover:bg-neutral-800/40"
            >
              <Music className="h-4 w-4 text-neutral-400" aria-hidden="true" />
              <span className="truncate text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                music · ready
              </span>
            </button>
            <div ref={slotRefCallback} className="ml-auto flex items-center gap-2" />
          </div>
        </div>
      );
    }
    return (
      <div
        ref={containerRef}
        className="pointer-events-auto fixed bottom-44 left-4 z-30 max-w-[calc(100vw-2rem)] sm:bottom-4"
      >
        <MediaDrawer open={expanded} onClose={() => setExpanded(false)} />
        <button
          type="button"
          onClick={handleNowPlayingClick}
          aria-label={expanded ? "close media drawer" : "open media drawer"}
          aria-expanded={expanded}
          className="flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/85 py-1.5 px-3 shadow-[0_8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md transition hover:bg-neutral-800/80"
        >
          <Music className="h-4 w-4 text-neutral-400" aria-hidden="true" />
          <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
            music · ready
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      // Two layouts share this body. In footer mode (claimed by a
      // consumer like SparFullView) the bar stretches across the full
      // bottom and exposes a right-side slot for injected controls. In
      // standalone mode it stays a 300px pill in the bottom-left, lifted
      // above the spar dock on mobile.
      className={
        footerMode
          ? "pointer-events-auto pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-neutral-800 bg-neutral-900/85 backdrop-blur-md shadow-[0_-8px_24px_rgba(0,0,0,0.45)]"
          : "pointer-events-auto fixed bottom-44 left-4 z-30 w-[300px] max-w-[calc(100vw-2rem)] sm:bottom-4"
      }
    >
      <MediaDrawer open={expanded} onClose={() => setExpanded(false)} />
      <div
        className={
          footerMode
            ? "mx-auto flex w-full items-center gap-2 px-3 py-1"
            : "flex items-center gap-3 rounded-2xl border border-neutral-800 bg-neutral-900/85 px-2.5 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md"
        }
      >
        <button
          type="button"
          onClick={handleNowPlayingClick}
          className={
            footerMode
              ? "flex min-w-0 cursor-pointer items-center gap-2 rounded-lg text-left transition hover:bg-neutral-800/40"
              : "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-left transition hover:bg-neutral-800/40"
          }
          aria-label={expanded ? "close media drawer" : "open media drawer"}
          aria-expanded={expanded}
        >
          <ArtSlot fillerNow={fillerNow} compact={footerMode} />
          <div className="flex min-w-0 flex-col">
            <span
              className={
                footerMode
                  ? "max-w-[12rem] truncate text-[11px] leading-tight font-medium text-neutral-100 sm:max-w-[18rem]"
                  : "truncate text-[12px] leading-tight font-medium text-neutral-100"
              }
            >
              {primaryLabel(fillerNow)}
            </span>
            <span
              className={
                footerMode
                  ? "hidden text-[9px] uppercase tracking-[0.18em] text-neutral-500 sm:block"
                  : "text-[10px] uppercase tracking-[0.18em] text-neutral-500"
              }
            >
              {secondaryLabel(
                fillerNow,
                youtubeQueue.length,
                newsUpcoming.length,
              )}
            </span>
          </div>
        </button>
        <div className="flex items-center gap-0.5">
          {isMedia ? (
            <>
              <IconButton
                label={isPlaying ? "pause" : "play"}
                onClick={handlePlayPause}
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </IconButton>
              <IconButton label="skip" onClick={handleSkip}>
                <SkipForward className="h-4 w-4" />
              </IconButton>
              {/* Volume slider only applies to YouTube — news plays
                  through Web Audio with its own gain envelope and the
                  user doesn't have a per-clip slider for it. */}
              {isYoutube && (
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
              )}
              <YoutubePiPButton />
            </>
          ) : (
            <ActivityDot fillerNow={fillerNow} />
          )}
        </div>
        {footerMode && (
          <div
            ref={slotRefCallback}
            className="ml-auto flex items-center gap-2 border-l border-neutral-800/80 pl-2"
          />
        )}
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

function thumbForFiller(
  fillerNow: Extract<FillerNow, { kind: "youtube" }>,
): string | null {
  if (fillerNow.thumbnailUrl) return fillerNow.thumbnailUrl;
  if (fillerNow.videoId) {
    return `https://i.ytimg.com/vi/${fillerNow.videoId}/hqdefault.jpg`;
  }
  return null;
}

function ArtSlot({
  fillerNow,
  compact = false,
}: {
  fillerNow: FillerNow;
  compact?: boolean;
}) {
  const sizeCls = compact ? "h-7 w-7" : "h-10 w-10";
  const iconCls = compact ? "h-4 w-4" : "h-5 w-5";
  if (fillerNow.kind === "youtube") {
    const thumb = thumbForFiller(fillerNow);
    if (thumb) {
      return (
        <div
          className={`relative ${sizeCls} shrink-0 overflow-hidden rounded-md bg-neutral-800`}
        >
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
      <div
        className={`flex ${sizeCls} shrink-0 items-center justify-center rounded-md bg-neutral-800 text-neutral-500`}
      >
        <Music className={iconCls} />
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
      className={`flex ${sizeCls} shrink-0 items-center justify-center rounded-md ${tint}`}
    >
      <Icon className={`${iconCls} ${animate ? "animate-pulse" : ""}`} />
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
        ? "bg-orange-400"
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
      // Show the headline as the track title; fall back when the
      // sidecar metadata is missing for an older cached clip.
      return fillerNow.title ?? "News headline";
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

function secondaryLabel(
  fillerNow: FillerNow,
  queueLength: number,
  newsUpcomingLength: number,
): string {
  switch (fillerNow.kind) {
    case "youtube": {
      const base = fillerNow.status === "playing" ? "now playing" : "paused";
      if (queueLength > 0) {
        return `${base} · +${queueLength} queued`;
      }
      return base;
    }
    case "news": {
      const state = fillerNow.paused ? "paused" : "now playing";
      const tail =
        fillerNow.source ??
        (newsUpcomingLength > 0
          ? `+${newsUpcomingLength} headlines`
          : "headlines");
      return `${state} · ${tail}`;
    }
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
    case "speaking":
      return { icon: Radio, tint: "bg-orange-900/30 text-orange-200" };
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
            tint: "bg-orange-900/30 text-orange-200",
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

