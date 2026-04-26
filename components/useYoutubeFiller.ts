"use client";

import { useEffect, useRef } from "react";

/**
 * Hidden YouTube player that acts as an alternative to the
 * TTS-news filler. When SparProvider tells this hook that thinking
 * is active AND a `videoId` has been selected (via the MCP
 * `youtube_play` tool), the iframe plays; when thinking ends the
 * iframe pauses. A new thinking window resumes from the paused
 * position automatically — YouTube's IFrame API preserves the
 * playhead across play/pause.
 *
 * Architecture:
 *   - Singleton YouTube IFrame API script (loaded once across all
 *     mounts of this hook; subsequent mounts wait on the same
 *     ready promise).
 *   - One off-screen 1×1 div per hook instance, appended to
 *     document.body. The `YT.Player()` call replaces that div with
 *     the iframe, so we position it off-screen rather than display
 *     none (some browsers suspend media in hidden iframes).
 *   - Position reports to `/api/youtube/state` every 2 s while the
 *     server says status="playing". Server exposes this via
 *     `youtube_status`.
 *
 * Autoplay caveat: modern browsers require a user gesture for video
 * playback with audio. SparProvider only activates this hook after
 * the user has clicked to start a voice session, which satisfies
 * the gesture, so in practice we don't hit the block. On the rare
 * first render where we do, `playVideo()` silently fails and the
 * next user interaction unblocks it.
 */

// Minimal subset of YT.Player's surface that we actually call. The
// full type lives in `@types/youtube` but pulling a whole package
// for four methods isn't worth it.
interface YTPlayer {
  loadVideoById(videoId: string): void;
  // Bare-id form only — we apply seeks via seekTo() after the
  // state-change fires CUED, which is more reliable across host
  // variations than the object-form overload.
  cueVideoById(videoId: string): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getVolume(): number;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getPlayerState(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement | string,
    config: {
      videoId?: string;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YTPlayer }) => void;
        onStateChange?: (event: { data: number; target: YTPlayer }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
    __amasoYtReady?: Promise<YTNamespace>;
  }
}

function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("no window"));
  }
  // Reuse a single promise across every hook instance so we never
  // inject the IFrame API script twice even if several Spar tabs
  // mount in the same runtime.
  if (window.__amasoYtReady) return window.__amasoYtReady;

  window.__amasoYtReady = new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        prev?.();
      } catch {
        /* ignore */
      }
      if (window.YT && window.YT.Player) resolve(window.YT);
      else reject(new Error("YT.Player missing after ready"));
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("YT iframe API script failed to load"));
    document.head.appendChild(script);
  });
  return window.__amasoYtReady;
}

interface UseYoutubeFillerProps {
  /** True when music should be in a PLAYING state. Pauses when false
   *  (preserves playhead). Drives the big play/pause decisions — TTS
   *  hard-cutoff, telegram takeover, mode change. For transient
   *  user-speech gaps, use `ducked` instead; pausing on every VAD
   *  burst would cost a re-buffer on release. */
  active: boolean;
  /** True → instant mute (setVolume 0 + mute()) while playback
   *  continues, so the ~800 ms VAD decay doesn't cost a pause/play
   *  cycle. Transition back to false fades volume 0 → 100 over
   *  500 ms. Ignored while `active` is false (pausing dominates).
   *  Defaults to false if omitted. */
  ducked?: boolean;
  /** Server-selected video. Null means nothing selected; hook stays dormant. */
  videoId: string | null;
  /** Seek target (seconds) applied on cue-in for this videoId. Ignored
   *  once the video is loaded — YouTube preserves the playhead across
   *  pause/play, so we only use this on the initial cue. */
  startAtSec?: number | null;
  /** Metadata passed through for the localStorage persistence record
   *  so a page refresh after a server state loss can rebuild a full
   *  selection (title/thumbnail/duration — not just a bare videoId). */
  title?: string | null;
  thumbnailUrl?: string | null;
  durationSec?: number | null;
  /** Optional playlist URL, saved verbatim for future playlist support.
   *  The current system is single-video only so this is always null in
   *  practice; kept in the API surface so localStorage records stay
   *  forward-compatible. */
  playlistUrl?: string | null;
  /** Volume (0–100) to target on the FIRST fade-in after mount. After
   *  that, every normal unduck fades to 100 as before. Lets a refresh
   *  restore the exact resting volume from localStorage rather than
   *  snapping back to max. Defaults to 100 when omitted. */
  restoreVolume?: number | null;
  /** Continuous resting volume (0–100). Drives both the fade-in target
   *  AND a live setVolume snap when the user moves the mini-player
   *  slider. Distinct from `restoreVolume`, which is only consulted on
   *  the first fade after mount. Ignored while ducked (we keep the
   *  player muted regardless). Defaults to 100. */
  volume?: number;
  /** Server-side sticky pause state for this user's selection. Saved
   *  into localStorage so a refresh during a "hold on, be quiet"
   *  pause comes back still paused, not auto-resumed. The hook itself
   *  doesn't act on this directly — the `active` prop already handles
   *  the play/pause decision — it's plumbed through purely for
   *  persistence. */
  serverStatus?: "playing" | "paused" | "idle" | null;
  /** When this number changes, the hook seeks the player to the
   *  current `startAtSec` (the latest server-reported position).
   *  Used for the Telegram→dashboard handoff: while a Telegram call
   *  was active the Python service was advancing the position via
   *  /api/youtube/state action=report_position; on hangup the parent
   *  bumps this signal so the iframe jumps to the right second
   *  rather than resuming from its locally-paused playhead. Pass a
   *  fresh number (timestamp, counter — anything ≠ previous value)
   *  to trigger; same value or omit leaves the playhead alone. */
  resyncSignal?: number;
  /** Called once when the player reaches ENDED for the loaded video.
   *  Used to auto-advance the queue server-side. Optional — if absent,
   *  ENDED is a no-op and the user has to skip manually. */
  onEnded?: () => void;
}

const POSITION_REPORT_INTERVAL_MS = 2_000;
// Slightly coarser than the server position-report tick because
// localStorage writes are cheaper but restore is only meaningful to
// ~5 s granularity anyway (a page refresh takes longer than that).
const LOCALSTORAGE_SAVE_INTERVAL_MS = 5_000;
const LOCALSTORAGE_KEY = "spar-youtube-playback";

interface SavedPlaybackRecord {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  positionSec: number;
  playlistUrl: string | null;
  /** Last-known resting volume (0–100). Captured at save time from
   *  the YT player so a future user-facing volume control
   *  auto-persists without any extra plumbing. Ducked reads are
   *  filtered out — we skip saves while muted so the resting level
   *  isn't overwritten with 0. */
  volume: number;
  /** Sticky pause state tracked by the server (see
   *  lib/youtube-state.ts). "paused" means the user explicitly said
   *  "hold on, silence" and we must stay paused through thinking
   *  windows. "playing" is the normal case. Not saved as "idle" —
   *  idle is represented by the absence of a record. */
  status: "playing" | "paused";
  savedAt: number;
}

function _safeIsMuted(player: YTPlayer): boolean | null {
  try {
    return player.isMuted();
  } catch {
    return null;
  }
}

export function useYoutubeFiller({
  active,
  ducked = false,
  videoId,
  startAtSec,
  title = null,
  thumbnailUrl = null,
  durationSec = null,
  playlistUrl = null,
  restoreVolume = null,
  volume = 100,
  serverStatus = null,
  resyncSignal,
  onEnded,
}: UseYoutubeFillerProps): void {
  const playerRef = useRef<YTPlayer | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const loadedVideoIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const activeRef = useRef(false);
  const duckedRef = useRef(false);
  const videoIdRef = useRef<string | null>(null);
  const startAtRef = useRef<number | null>(null);
  // Set true once we apply a seek for the current loaded video, so
  // we don't re-seek on every CUED event (CUED fires again on
  // subsequent re-cues / format switches — doesn't need a re-seek).
  const seekAppliedRef = useRef(false);
  const positionTimerRef = useRef<number | null>(null);
  const localSaveTimerRef = useRef<number | null>(null);

  // Render-time diagnostic so DevTools shows exactly what the hook
  // was given per render + what internal state thinks of it. Prefer
  // this over a change-tracking effect because the rendering context
  // (browser tab open, thinking active, etc.) is the thing we want
  // visible when the bug reappears.
  if (typeof window !== "undefined") {
    console.info("[FILLER-DEBUG] hook: render", {
      active,
      ducked,
      videoId,
      startAtSec,
      hasPlayer: !!playerRef.current,
      ready: readyRef.current,
      loadedVideoId: loadedVideoIdRef.current,
    });
  }
  // Latest metadata — refs instead of direct closure capture so the
  // 5 s localStorage tick always writes the freshest title/thumbnail
  // without forcing a timer restart on every prop change. We also
  // stash serverStatus here so the save tick can write "playing" vs
  // "paused" without depending on another layer of state plumbing.
  const metaRef = useRef<{
    title: string | null;
    thumbnailUrl: string | null;
    durationSec: number | null;
    playlistUrl: string | null;
    serverStatus: "playing" | "paused" | "idle" | null;
  }>({ title, thumbnailUrl, durationSec, playlistUrl, serverStatus });
  useEffect(() => {
    metaRef.current = {
      title,
      thumbnailUrl,
      durationSec,
      playlistUrl,
      serverStatus,
    };
  }, [title, thumbnailUrl, durationSec, playlistUrl, serverStatus]);

  // One-shot "apply restoreVolume on the first fade-in" flag. Set
  // true on mount when a non-null restoreVolume is supplied; the
  // fade-in path reads + clears it so subsequent resumes (after the
  // initial one) revert to fading up to 100. Tracks intent, not
  // current volume — that's read directly from the player.
  const restoreVolumeAppliedRef = useRef(false);
  const restoreVolumeTargetRef = useRef<number | null>(restoreVolume);
  useEffect(() => {
    restoreVolumeTargetRef.current = restoreVolume;
    // Reset the applied flag if a fresh restoreVolume comes in (e.g.
    // a new mount with a different saved record). Unusual in practice
    // since restoreVolume is meant to be a one-shot mount value, but
    // safer to keep the two in lockstep.
    if (restoreVolume != null) restoreVolumeAppliedRef.current = false;
  }, [restoreVolume]);

  // Continuous volume: drives the fade-in target after the one-shot
  // restore is consumed AND lets the mini-player slider snap the
  // current volume mid-playback without going through a duck/unduck
  // cycle.
  const volumeRef = useRef<number>(volume);
  useEffect(() => {
    volumeRef.current = volume;
    const player = playerRef.current;
    if (!player || !readyRef.current) return;
    if (!activeRef.current || duckedRef.current) return;
    // Mid-fade: cancel and snap to the new target. Slider drags fire
    // many setVolume calls per second; running fades on top would
    // lag the visible level by the fade duration.
    cancelFadeTimer();
    try {
      if (player.isMuted()) player.unMute();
    } catch {
      /* ignore */
    }
    try {
      player.setVolume(Math.max(0, Math.min(100, Math.round(volume))));
    } catch {
      /* ignore — state transitions can race */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume]);

  // Stash the latest onEnded in a ref so the player's onStateChange
  // handler — which is closed over once at construction — can read
  // the most recent callback without forcing a player rebuild on
  // every render. The parent passes a fresh function on each render,
  // so a closure capture would call a stale version.
  const onEndedRef = useRef<typeof onEnded>(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  // Track the last video we already fired ENDED for so a delayed
  // ENDED state-change (some hosts re-emit) doesn't double-advance
  // the queue.
  const endedFiredForRef = useRef<string | null>(null);

  // Mount-only: create the hidden div + player; tear down on unmount.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mount = document.createElement("div");
    mount.id = `amaso-yt-player-${Math.random().toString(36).slice(2, 8)}`;
    // YouTube refuses to initialise / throttles playback in tiny
    // iframes (the 1×1 "audio-only" trick silently fails: state
    // never reaches PLAYING and the position stays at 0). Give the
    // player a proper 320×180 canvas and hide it off-screen via
    // position + offset. `display:none` is NOT safe — some browsers
    // suspend media in fully-hidden iframes — so we leave the
    // element rendered but scrolled out of view.
    Object.assign(mount.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "320px",
      height: "180px",
      pointerEvents: "none",
      opacity: "0",
      zIndex: "-1",
    });
    document.body.appendChild(mount);
    mountRef.current = mount;

    let cancelled = false;

    void (async () => {
      let YT: YTNamespace;
      try {
        YT = await loadYouTubeApi();
      } catch {
        return;
      }
      if (cancelled) return;

      // The Player constructor REPLACES `mount` with an iframe. We
      // keep the pre-insert reference because YT's replacement
      // detaches our original node — any subsequent DOM queries
      // need to find the new iframe (which YT gives us via the
      // event target, so we don't even need to).
      //
      // Autoplay policy note: Chrome/Firefox gate `playVideo()` in
      // cross-origin iframes behind a recent user gesture, and a
      // click on the parent page does NOT reliably propagate into
      // the youtube-nocookie iframe. The escape hatch is to start
      // `mute: 1` (muted autoplay is allowed unconditionally), then
      // call `unMute()` on the first PLAYING event — by that point
      // the player is alive and our subsequent unmute request lands
      // because the page itself has user activation from the voice
      // session start.
      const player = new YT.Player(mount, {
        host: "https://www.youtube-nocookie.com",
        playerVars: {
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          playsinline: 1,
          iv_load_policy: 3,
          fs: 0,
          rel: 0,
          autoplay: 0,
          mute: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: ({ target }) => {
            if (cancelled) {
              try {
                target.destroy();
              } catch {
                /* ignore */
              }
              return;
            }
            playerRef.current = target;
            readyRef.current = true;
            console.info(
              "[FILLER-DEBUG] hook: player ready",
              { videoId: videoIdRef.current, active: activeRef.current },
            );
            // If a video was already selected before the player
            // became ready, sync up now.
            applyVideo();
            applyActive();
          },
          onStateChange: ({ data, target }) => {
            // 1=PLAYING, 2=PAUSED, 3=BUFFERING, 5=CUED, 0=ENDED, -1=UNSTARTED
            console.info("[FILLER-DEBUG] hook: state change:", data);
            if (!window.YT) return;
            // CUED → apply any pending seek once the buffer is ready.
            // allowSeekAhead=true lets YT request the correct chunk
            // rather than playing silence up to the target.
            if (data === window.YT.PlayerState.CUED) {
              const wantSeek = startAtRef.current ?? 0;
              if (wantSeek > 0.5 && !seekAppliedRef.current) {
                try {
                  target.seekTo(wantSeek, true);
                  seekAppliedRef.current = true;
                  console.info(
                    "[FILLER-DEBUG] hook: seeked on CUED:",
                    `t=${wantSeek.toFixed(1)}s`,
                  );
                } catch (err) {
                  console.warn("[FILLER-DEBUG] hook: seek failed:", err);
                }
              }
            }
            if (data === window.YT.PlayerState.ENDED) {
              const finishedId = loadedVideoIdRef.current;
              if (finishedId && endedFiredForRef.current !== finishedId) {
                endedFiredForRef.current = finishedId;
                console.info(
                  "[FILLER-DEBUG] hook: ENDED → calling onEnded",
                  { videoId: finishedId },
                );
                try {
                  onEndedRef.current?.();
                } catch (err) {
                  console.warn("[FILLER-DEBUG] hook: onEnded callback threw:", err);
                }
              }
            }
            if (data === window.YT.PlayerState.PLAYING) {
              // Unmute on first confirmed play. Idempotent — safe to
              // call even if already unmuted. This is the flip side
              // of mute:1 above; without it the audio would stay
              // muted forever.
              try {
                if (target.isMuted()) {
                  target.unMute();
                  target.setVolume(100);
                  console.info("[FILLER-DEBUG] hook: unmuted on PLAYING");
                }
              } catch (err) {
                console.warn("[FILLER-DEBUG] hook: unmute failed:", err);
              }
              startPositionReporting();
            } else {
              stopPositionReporting();
            }
          },
          onError: ({ data }) => {
            // 2   = invalid video id
            // 5   = HTML5 player error
            // 100 = video not found / removed / private
            // 101 / 150 = embedding disabled by the uploader
            const deadVideoCodes = [2, 100, 101, 150];
            const deadVideo = deadVideoCodes.includes(data);
            const vid = videoIdRef.current;
            console.warn(
              "[FILLER-DEBUG] hook: player error code:", data,
              { videoId: vid, deadVideo },
            );
            if (!deadVideo || !vid) return;
            // Video is permanently unreachable — clear localStorage
            // so the next refresh doesn't retry the same dead id
            // forever, and tell the server to stop (which also flips
            // filler mode back to news). Fire-and-forget: we're
            // already in an error handler, nothing to do if this
            // fails except log.
            try {
              window.localStorage.removeItem(LOCALSTORAGE_KEY);
            } catch {
              /* ignore */
            }
            void fetch("/api/youtube/state", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "stop" }),
              cache: "no-store",
            }).catch(() => {
              /* non-fatal — server state will self-clear on its 6h TTL */
            });
          },
        },
      });
      playerRef.current = player;
    })();

    return () => {
      cancelled = true;
      stopPositionReporting();
      cancelFadeTimer();
      if (localSaveTimerRef.current !== null) {
        window.clearInterval(localSaveTimerRef.current);
        localSaveTimerRef.current = null;
      }
      try {
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      try {
        mountRef.current?.remove();
      } catch {
        /* ignore — YT may have already replaced/removed the node */
      }
      mountRef.current = null;
      readyRef.current = false;
      loadedVideoIdRef.current = null;
    };
    // Mount-only — second effect responds to prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to videoId + active prop changes.
  useEffect(() => {
    videoIdRef.current = videoId;
    startAtRef.current = startAtSec ?? null;
    applyVideo();
  }, [videoId, startAtSec]);

  // Resync handoff: parent bumps `resyncSignal` after a Telegram call
  // ends so the iframe seeks to the latest server-reported position
  // (the Python service was advancing it via report_position during
  // the call). Without this, resume would pick up at the playhead
  // where we paused PRE-call, repeating audio the user already heard
  // on the phone.
  //
  // We deliberately don't fire on the first render — the seekAppliedRef
  // path in the CUED handler covers initial-cue seeking. This effect
  // is only for live resyncs on an already-loaded video. Skip if
  // startAtRef is null/0/tiny (Python never reported, no meaningful
  // resync target — seeking would just rewind to 0).
  const firstResyncRef = useRef(true);
  useEffect(() => {
    if (firstResyncRef.current) {
      firstResyncRef.current = false;
      return;
    }
    if (resyncSignal === undefined) return;
    const target = startAtRef.current ?? 0;
    if (target < 1) return;
    const player = playerRef.current;
    if (!player || !readyRef.current) return;
    try {
      console.info(
        "[FILLER-DEBUG] hook: resync seek →",
        target.toFixed(1),
        "s (signal=",
        resyncSignal,
        ")",
      );
      player.seekTo(target, true);
    } catch (err) {
      console.warn("[FILLER-DEBUG] hook: resync seek failed:", err);
    }
  }, [resyncSignal]);

  useEffect(() => {
    activeRef.current = active;
    applyActive();
  }, [active]);

  useEffect(() => {
    duckedRef.current = ducked;
    applyActive();
  }, [ducked]);

  // Persist the playhead to localStorage every 5 s while a video is
  // loaded. Runs regardless of active/ducked state — the point is to
  // remember what was playing even if the user is currently speaking
  // (ducked) and then refreshes. getCurrentTime() on a paused player
  // returns the last playhead, so ducked reads don't reset position.
  //
  // Volume handling: we deliberately SKIP saves while the player is
  // muted (i.e. during a VAD duck or while fading up from 0). Otherwise
  // a refresh in the middle of a fade-in would pin restoreVolume to a
  // nonsense intermediate value like 34. Resting reads only.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!videoId) return; // nothing to persist
    const tick = () => {
      const player = playerRef.current;
      const vid = videoIdRef.current;
      if (!player || !vid) return;
      let pos = 0;
      try {
        pos = player.getCurrentTime() || 0;
      } catch {
        return;
      }
      // Only read volume when not muted AND not mid-fade. We detect
      // mid-fade by the presence of fadeTimerRef — if it's live, the
      // volume is being ramped and we can't trust the reading.
      let vol: number | undefined;
      try {
        const muted = player.isMuted();
        if (!muted && fadeTimerRef.current === null) {
          const raw = player.getVolume();
          if (typeof raw === "number" && raw > 0) vol = Math.round(raw);
        }
      } catch {
        /* ignore — leave vol undefined so the prior saved level is kept */
      }
      saveToLocalStorage(vid, pos, vol);
    };
    // Write immediately so any metadata change (title etc.) lands
    // without waiting for the first 5 s interval to elapse.
    tick();
    const id = window.setInterval(tick, LOCALSTORAGE_SAVE_INTERVAL_MS);
    localSaveTimerRef.current = id;
    return () => {
      window.clearInterval(id);
      if (localSaveTimerRef.current === id) localSaveTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, title, thumbnailUrl, durationSec, playlistUrl, serverStatus]);

  function applyVideo(): void {
    const player = playerRef.current;
    if (!player || !readyRef.current) {
      console.info(
        "[FILLER-DEBUG] hook: applyVideo skipped — player not ready",
        { hasPlayer: !!player, ready: readyRef.current, target: videoIdRef.current },
      );
      return;
    }
    const targetId = videoIdRef.current;

    if (!targetId) {
      // Selection cleared — stop + forget so the next play starts
      // cleanly rather than picking up a stale playhead. Also wipe
      // the localStorage record so a subsequent refresh doesn't
      // auto-restore something the user just stopped.
      try {
        player.stopVideo();
      } catch {
        /* ignore */
      }
      loadedVideoIdRef.current = null;
      clearLocalStorage();
      console.info("[FILLER-DEBUG] hook: cleared selection + localStorage");
      return;
    }

    if (loadedVideoIdRef.current === targetId) {
      // Same video still loaded; nothing to do beyond letting the
      // next play/pause toggle drive playback.
      return;
    }

    try {
      // Always bare-id cue — the object-form overload showed us
      // flaky behaviour in some iframe configurations. Any seek
      // target is applied in onStateChange's CUED branch instead,
      // which runs ~once the buffer metadata is actually available.
      console.info("[FILLER-DEBUG] hook: cueing video:", targetId);
      player.cueVideoById(targetId);
      loadedVideoIdRef.current = targetId;
      seekAppliedRef.current = false;
      endedFiredForRef.current = null;
      // Immediately persist the new selection so a refresh mid-first-
      // play has something to restore. Position will be filled in by
      // the 5 s tick once playback starts.
      const startAt = startAtRef.current ?? 0;
      saveToLocalStorage(targetId, startAt);
    } catch {
      /* ignore — player state transitions can race */
    }
  }

  function saveToLocalStorage(
    vid: string,
    positionSec: number,
    volume?: number,
  ): void {
    if (typeof window === "undefined") return;
    try {
      // Preserve the prior saved volume when the caller doesn't know
      // one (mid-fade / muted save, or early ticks before the player
      // reports). Falling back to 100 instead would clobber whatever
      // level the user had settled on.
      const prev = readPriorRecord();
      const meta = metaRef.current;
      const status: "playing" | "paused" =
        meta.serverStatus === "paused" ? "paused" : "playing";
      const record: SavedPlaybackRecord = {
        videoId: vid,
        title: meta.title,
        thumbnailUrl: meta.thumbnailUrl,
        durationSec: meta.durationSec,
        positionSec: Math.max(0, positionSec),
        playlistUrl: meta.playlistUrl,
        volume:
          typeof volume === "number"
            ? clampVolume(volume)
            : typeof prev?.volume === "number"
              ? clampVolume(prev.volume)
              : 100,
        status,
        savedAt: Date.now(),
      };
      window.localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(record));
    } catch {
      /* quota exceeded / privacy-mode — soft-fail, not fatal */
    }
  }

  function readPriorRecord(): SavedPlaybackRecord | null {
    try {
      const raw = window.localStorage.getItem(LOCALSTORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SavedPlaybackRecord>;
      if (!parsed || typeof parsed.videoId !== "string") return null;
      return parsed as SavedPlaybackRecord;
    } catch {
      return null;
    }
  }

  function clampVolume(v: number): number {
    if (!Number.isFinite(v)) return 100;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function clearLocalStorage(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(LOCALSTORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  const fadeTimerRef = useRef<number | null>(null);

  function cancelFadeTimer(): void {
    if (fadeTimerRef.current !== null) {
      window.clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }

  function applyActive(): void {
    const player = playerRef.current;
    if (!player || !readyRef.current) {
      console.info(
        "[FILLER-DEBUG] hook: applyActive skipped — player not ready",
        {
          hasPlayer: !!player,
          ready: readyRef.current,
          active: activeRef.current,
          ducked: duckedRef.current,
        },
      );
      return;
    }
    if (!videoIdRef.current) {
      console.info("[FILLER-DEBUG] hook: applyActive skipped — no videoId");
      return;
    }
    cancelFadeTimer();
    try {
      // State machine:
      //   !active                → pauseVideo (preserves playhead)
      //   active &&  ducked      → keep playing, mute instantly
      //   active && !ducked      → keep/start playing, fade 0→100
      //
      // The split exists because VAD ducking (the user speaking) is
      // a high-churn, short-duration signal — pausing on every
      // utterance would force a re-buffer on each 800 ms decay and
      // produce audible stutter. Muting instead keeps the player
      // "hot" and lets the fade-in on release do the smooth bit.
      // Non-VAD stops (TTS, telegram, mode change) are long-
      // duration and DO pause, both to save bandwidth and because
      // "no music during the assistant's reply" is the correct
      // user expectation.
      if (!activeRef.current) {
        console.info(
          "[FILLER-DEBUG] hook: applyActive → pauseVideo() (!active)",
          { videoId: videoIdRef.current },
        );
        try {
          player.pauseVideo();
        } catch {
          /* ignore */
        }
        return;
      }

      // Active. Make sure playback is running. Idempotent — safe to
      // call even if already PLAYING. This is also where the first
      // play() happens on initial cue.
      try {
        player.playVideo();
      } catch {
        /* ignore — state transitions can race */
      }

      if (duckedRef.current) {
        // INSTANT mute. We setVolume(0) AND call mute() — the
        // former is what actually silences the output path, the
        // latter is what getVolume/unMute toggles against. Both
        // idempotent.
        console.info(
          "[FILLER-DEBUG] hook: applyActive → duck (setVolume 0 + mute)",
          { videoId: videoIdRef.current },
        );
        try {
          player.setVolume(0);
        } catch {
          /* ignore */
        }
        try {
          if (!player.isMuted()) player.mute();
        } catch {
          /* ignore */
        }
        return;
      }

      // Active + not ducked: unmute and fade volume 0 → target over
      // 500 ms. Target is normally 100, but on the FIRST unduck after
      // a localStorage-restored mount we honour restoreVolume so a
      // refreshed session lands back at whatever resting level the
      // user had last time (rather than snapping to max). One-shot —
      // after this fade-in, the ref is consumed and subsequent
      // resumes go to 100 again.
      const restoreTarget = restoreVolumeTargetRef.current;
      const useRestore =
        restoreTarget != null &&
        restoreTarget >= 0 &&
        restoreTarget <= 100 &&
        !restoreVolumeAppliedRef.current;
      // After the one-shot restore has been consumed, fade-ins land on
      // whatever the mini-player slider currently asks for (defaults to
      // 100 if no slider is mounted).
      const sliderTarget = Math.max(
        0,
        Math.min(100, Math.round(volumeRef.current)),
      );
      const fadeTarget = useRestore ? (restoreTarget as number) : sliderTarget;
      if (useRestore) {
        restoreVolumeAppliedRef.current = true;
      }
      console.info(
        "[FILLER-DEBUG] hook: applyActive → unduck / fade-in",
        {
          videoId: videoIdRef.current,
          muted: _safeIsMuted(player),
          fadeTarget,
          useRestore,
        },
      );
      try {
        player.setVolume(0);
      } catch {
        /* ignore */
      }
      try {
        if (player.isMuted()) player.unMute();
      } catch {
        /* ignore */
      }
      const FADE_MS = 500;
      const STEP_MS = 50;
      const steps = Math.max(1, Math.round(FADE_MS / STEP_MS));
      let stepsDone = 0;
      fadeTimerRef.current = window.setInterval(() => {
        stepsDone += 1;
        const p = playerRef.current;
        if (!p) {
          cancelFadeTimer();
          return;
        }
        const level = Math.min(
          fadeTarget,
          Math.round((fadeTarget * stepsDone) / steps),
        );
        try {
          p.setVolume(level);
        } catch {
          /* ignore */
        }
        if (stepsDone >= steps) cancelFadeTimer();
      }, STEP_MS);
    } catch {
      /* ignore — early calls can race the player state */
    }
  }

  function startPositionReporting(): void {
    stopPositionReporting();
    positionTimerRef.current = window.setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      let pos = 0;
      try {
        pos = player.getCurrentTime() || 0;
      } catch {
        return;
      }
      void fetch("/api/youtube/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "report_position", position_sec: pos }),
        cache: "no-store",
      }).catch(() => {
        /* reports are fire-and-forget; network blip is fine */
      });
    }, POSITION_REPORT_INTERVAL_MS);
  }

  function stopPositionReporting(): void {
    if (positionTimerRef.current !== null) {
      window.clearInterval(positionTimerRef.current);
      positionTimerRef.current = null;
    }
  }
}
