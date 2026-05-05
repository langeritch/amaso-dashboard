"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { YoutubeNowPlaying, YoutubeQueueItem } from "./SparContext";
import { useYoutubeFiller } from "./useYoutubeFiller";
import type { useVoiceChannel } from "./useVoiceChannel";

/**
 * Single source of truth for client-side media-player state. All
 * youtube/queue/volume/control wiring that used to live scattered
 * inside SparProvider funnels through here so SparContext exposes one
 * coherent API:
 *
 *   - nowPlaying / queue   — mirror of voice.youtube (server is the
 *                            cross-device source of truth, polled every
 *                            100 ms via useVoiceChannel)
 *   - volume               — pure client preference, init from the
 *                            localStorage record so a refresh restores
 *                            the resting level
 *   - play/pause/.../etc.  — POSTs to /api/youtube/state; the next poll
 *                            settles the visible state
 *   - ytRestoring          — mount-time guard so the "no selection →
 *                            news fallback" branch in SparProvider stays
 *                            silent during the brief restore race
 *
 * The iframe driver (useYoutubeFiller) is still mounted from here — it
 * owns the YT IFrame side effect, but its props are all derived from
 * the state this hook manages.
 */

type VoiceSnapshot = ReturnType<typeof useVoiceChannel>;

interface UseMediaPlayerProps {
  voice: VoiceSnapshot;
  /** True when the player should be in PLAYING state. Computed by
   *  SparProvider from the cross-cutting filler decision (selection +
   *  channel + TTS quiet + nobody talking). */
  ytMusicShouldPlay: boolean;
  /** True when the player should be ducked (instant mute, fast unduck
   *  on release). Driven by VAD. */
  ytMusicDucked: boolean;
}

export interface MediaPlayerApi {
  nowPlaying: YoutubeNowPlaying;
  queue: YoutubeQueueItem[];
  volume: number;
  setVolume: (v: number) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  skip: () => void;
  enqueue: (item: YoutubeQueueItem) => void;
  clearQueue: () => void;
  removeFromQueue: (videoId: string) => void;
  reorderQueue: (fromIdx: number, toIdx: number) => void;
  /** True while the mount-time localStorage restore POST is in-flight.
   *  SparProvider uses this to suppress the "no selection → fall back
   *  to news" branch during the 100–500 ms race where the server
   *  in-memory state hasn't yet been rebuilt. */
  ytRestoring: boolean;
}

type SavedRecord = {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  positionSec: number;
  playlistUrl: string | null;
  /** Resting volume (0–100). Default 100 when absent (pre-extension
   *  records). Fed to useYoutubeFiller as restoreVolume so the first
   *  fade-in lands at the user's prior level. */
  volume: number;
  /** Sticky server status. "paused" means the user explicitly held
   *  silence — after we POST action=play to restore the selection,
   *  we follow up with action=pause so the server state matches. */
  status: "playing" | "paused";
  /** Mirror of voice.youtube.queue at save time — re-enqueued via
   *  POST action=enqueue on mount restore so a refresh keeps every
   *  upcoming track in order, not just the one that was playing. */
  queue?: YoutubeQueueItem[];
  savedAt: number;
};

const LOCALSTORAGE_KEY = "spar-youtube-playback";
// Match the server-side youtube-state TTL — past that the user
// probably doesn't want the music to ambush them on refresh.
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function useMediaPlayer({
  voice,
  ytMusicShouldPlay,
  ytMusicDucked,
}: UseMediaPlayerProps): MediaPlayerApi {
  const ytVideoId = voice.youtube.videoId;

  const [savedRestore, setSavedRestore] = useState<SavedRecord | null>(null);
  const [ytRestoring, setYtRestoring] = useState(false);

  // Mount-only restore: read localStorage, rebuild server selection
  // via /api/youtube/state, hold the suppression flag until the next
  // poll lands the matching videoId.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(LOCALSTORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: Partial<SavedRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<SavedRecord>;
    } catch {
      return;
    }
    const vid = parsed.videoId;
    if (typeof vid !== "string" || vid.length !== 11) return;
    const pos =
      typeof parsed.positionSec === "number" && parsed.positionSec >= 0
        ? parsed.positionSec
        : 0;
    const savedAt =
      typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    if (savedAt > 0 && Date.now() - savedAt > SIX_HOURS_MS) {
      try {
        window.localStorage.removeItem(LOCALSTORAGE_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    const rawVolume =
      typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
        ? parsed.volume
        : 100;
    const volume = Math.max(0, Math.min(100, Math.round(rawVolume)));
    const status: "playing" | "paused" =
      parsed.status === "paused" ? "paused" : "playing";
    const queue: YoutubeQueueItem[] = Array.isArray(parsed.queue)
      ? (parsed.queue as YoutubeQueueItem[])
          .filter(
            (q): q is YoutubeQueueItem =>
              !!q && typeof q.videoId === "string" && q.videoId.length === 11,
          )
          .map((q) => ({
            videoId: q.videoId,
            title: typeof q.title === "string" ? q.title : null,
            thumbnailUrl:
              typeof q.thumbnailUrl === "string" ? q.thumbnailUrl : null,
            durationSec:
              typeof q.durationSec === "number" ? q.durationSec : null,
          }))
      : [];
    const record: SavedRecord = {
      videoId: vid,
      title: (parsed.title as string | null) ?? null,
      thumbnailUrl: (parsed.thumbnailUrl as string | null) ?? null,
      durationSec:
        typeof parsed.durationSec === "number" ? parsed.durationSec : null,
      positionSec: pos,
      playlistUrl: (parsed.playlistUrl as string | null) ?? null,
      volume,
      status,
      queue,
      savedAt,
    };
    setSavedRestore(record);
    setYtRestoring(true);
    console.info(
      "[YT-FILLER] restoring from localStorage:",
      {
        videoId: vid,
        positionSec: pos,
        title: record.title,
        volume,
        status,
        queueLength: queue.length,
      },
    );
    void (async () => {
      try {
        await fetch("/api/youtube/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "play",
            video_id: vid,
            title: record.title,
            thumbnail_url: record.thumbnailUrl,
            duration_sec: record.durationSec,
          }),
          cache: "no-store",
        });
        if (status === "paused") {
          await fetch("/api/youtube/state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "pause" }),
            cache: "no-store",
          });
        }
        // Re-seed the server queue from the saved order. Fire each
        // enqueue serially so the resulting queue arrives in the same
        // order the user had before refresh; parallel POSTs would
        // interleave non-deterministically.
        for (const q of queue) {
          await fetch("/api/youtube/state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "enqueue",
              video_id: q.videoId,
              title: q.title,
              thumbnail_url: q.thumbnailUrl,
              duration_sec: q.durationSec,
            }),
            cache: "no-store",
          });
        }
      } catch {
        /* non-fatal — ytRestoring timeout below clears the flag */
      }
    })();
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear ytRestoring once the server-side videoId matches the record
  // OR after a 4 s safety timeout (failed restore POST shouldn't pin
  // the suppression forever).
  useEffect(() => {
    if (!ytRestoring) return;
    if (savedRestore && voice.youtube.videoId === savedRestore.videoId) {
      setYtRestoring(false);
      return;
    }
    const id = window.setTimeout(() => setYtRestoring(false), 4_000);
    return () => window.clearTimeout(id);
  }, [ytRestoring, savedRestore, voice.youtube.videoId]);

  // Use the saved position only while the current selection matches
  // what was saved. A fresh play / different video resets back to the
  // server-reported position.
  const startAtSec =
    savedRestore && ytVideoId === savedRestore.videoId
      ? savedRestore.positionSec
      : voice.youtube.positionSec;

  // Mini-player slider. Initialised once from the saved record so a
  // refresh lands at the prior resting level; updated live as the
  // user drags. Passed to useYoutubeFiller as `volume`, which snaps
  // the iframe volume on every change.
  const [volume, setVolume] = useState<number>(100);
  const volumeInitRef = useRef(false);
  useEffect(() => {
    if (volumeInitRef.current) return;
    if (savedRestore && typeof savedRestore.volume === "number") {
      setVolume(
        Math.max(0, Math.min(100, Math.round(savedRestore.volume))),
      );
      volumeInitRef.current = true;
    }
  }, [savedRestore]);

  // Persist the live queue back into the same localStorage record
  // useYoutubeFiller writes for now-playing. We read-modify-write so
  // we never clobber its videoId / position / volume / status fields
  // — the queue is a sidecar slot on the same record. Skipped when
  // the iframe hasn't written its first record yet (no prior key on
  // disk → nothing to merge into; the next nowPlaying tick will
  // create the record and pick up the queue on its read-merge).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const queueSnapshot: YoutubeQueueItem[] = voice.youtube.queue.map((q) => ({
      videoId: q.videoId,
      title: q.title,
      thumbnailUrl: q.thumbnailUrl,
      durationSec: q.durationSec,
    }));
    try {
      const raw = window.localStorage.getItem(LOCALSTORAGE_KEY);
      if (!raw) return;
      const prev = JSON.parse(raw) as Partial<SavedRecord>;
      if (!prev || typeof prev.videoId !== "string") return;
      const next: Partial<SavedRecord> = { ...prev, queue: queueSnapshot };
      window.localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota / parse blip — not fatal, next tick retries */
    }
  }, [voice.youtube.queue]);

  // Telegram→dashboard handoff resync. While a call is active the
  // Python service advances voice.youtube.positionSec; the iframe is
  // paused locally so its own playhead is frozen at the pre-call
  // value. Bumping resyncSignal on hangup makes useYoutubeFiller seek
  // to the fresher server position before resuming.
  const lastChannelRef = useRef(voice.channel);
  const [resyncSignal, setResyncSignal] = useState<number>(0);
  useEffect(() => {
    const prev = lastChannelRef.current;
    lastChannelRef.current = voice.channel;
    if (prev === "telegram" && voice.channel !== "telegram") {
      setResyncSignal(Date.now());
    }
  }, [voice.channel]);

  // Auto-advance: when the iframe finishes a video, hit the advance
  // endpoint so the server promotes the next queue item (or stops if
  // the queue is empty).
  const handleVideoEnded = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal — next poll re-syncs */
    });
  }, []);

  useYoutubeFiller({
    active: ytMusicShouldPlay,
    ducked: ytMusicDucked,
    videoId: ytVideoId,
    startAtSec,
    title: voice.youtube.title,
    thumbnailUrl: voice.youtube.thumbnailUrl,
    durationSec: voice.youtube.durationSec,
    playlistUrl: savedRestore?.playlistUrl ?? null,
    restoreVolume:
      savedRestore && ytVideoId === savedRestore.videoId
        ? savedRestore.volume
        : null,
    volume,
    serverStatus: voice.youtube.status as "playing" | "paused" | "idle",
    resyncSignal,
    onEnded: handleVideoEnded,
  });

  const play = useCallback(() => {
    const vid = voice.youtube.videoId;
    if (!vid) return;
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "play",
        video_id: vid,
        title: voice.youtube.title,
        thumbnail_url: voice.youtube.thumbnailUrl,
        duration_sec: voice.youtube.durationSec,
      }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal — next poll re-syncs from server */
    });
  }, [
    voice.youtube.videoId,
    voice.youtube.title,
    voice.youtube.thumbnailUrl,
    voice.youtube.durationSec,
  ]);

  const pause = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  const stop = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  // Skip current track. Server promotes the head of the queue into
  // now-playing, or — if the queue is empty — falls back to a full
  // stop, returning the filler mode to news.
  const skip = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  const enqueue = useCallback((item: YoutubeQueueItem) => {
    if (!item || !item.videoId) return;
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "enqueue",
        video_id: item.videoId,
        title: item.title,
        thumbnail_url: item.thumbnailUrl,
        duration_sec: item.durationSec,
      }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  const clearQueue = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear_queue" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  const removeFromQueue = useCallback((videoId: string) => {
    if (!videoId) return;
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove_from_queue", video_id: videoId }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal — next session poll reconciles the queue */
    });
  }, []);

  const reorderQueue = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) return;
      if (fromIdx === toIdx) return;
      void fetch("/api/youtube/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reorder_queue",
          from_index: fromIdx,
          to_index: toIdx,
        }),
        cache: "no-store",
      }).catch(() => {
        /* non-fatal — next session poll reconciles the order */
      });
    },
    [],
  );

  const queue = useMemo(
    () =>
      voice.youtube.queue.map((q) => ({
        videoId: q.videoId,
        title: q.title,
        thumbnailUrl: q.thumbnailUrl,
        durationSec: q.durationSec,
      })),
    [voice.youtube.queue],
  );

  const nowPlaying = useMemo<YoutubeNowPlaying>(
    () => ({
      videoId: voice.youtube.videoId,
      title: voice.youtube.title,
      thumbnailUrl: voice.youtube.thumbnailUrl,
      durationSec: voice.youtube.durationSec,
      positionSec: voice.youtube.positionSec,
      // useVoiceChannel types `status` as `string` (it's whatever the
      // poll endpoint returns); narrow explicitly to the literal union.
      status: ((): "playing" | "paused" | "idle" => {
        if (voice.youtube.status === "playing") return "playing";
        if (voice.youtube.status === "paused") return "paused";
        return "idle";
      })(),
    }),
    [
      voice.youtube.videoId,
      voice.youtube.title,
      voice.youtube.thumbnailUrl,
      voice.youtube.durationSec,
      voice.youtube.positionSec,
      voice.youtube.status,
    ],
  );

  return {
    nowPlaying,
    queue,
    volume,
    setVolume,
    play,
    pause,
    stop,
    skip,
    enqueue,
    clearQueue,
    removeFromQueue,
    reorderQueue,
    ytRestoring,
  };
}
