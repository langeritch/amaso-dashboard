"use client";

import { useEffect, useState } from "react";

/**
 * Subscribes to the shared voice-session's active channel. Returns
 * the channel the audio is currently flowing through (spar, telegram,
 * chat) or null if no channel is held. Used by the Spar UI to surface
 * "Telegram is on speakerphone" without duplicating the session view.
 *
 * Polls once a second — cheap, the endpoint is all in-memory, and
 * anything tighter would waste CPU while not meaningfully improving
 * perceived latency.
 */

type Channel = "spar" | "telegram" | "chat" | null;

export interface VoiceTurnSnapshot {
  role: "user" | "assistant";
  text: string;
  at: number;
  channel: "spar" | "telegram" | "chat";
}

export interface YouTubeQueueItemSnapshot {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
}

export interface YouTubeFillerSnapshot {
  videoId: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  positionSec: number;
  /** "idle" | "playing" | "paused" — server's intent for this slot. */
  status: string;
  /** Tracks waiting after the current one. Empty when nothing queued. */
  queue: YouTubeQueueItemSnapshot[];
}

export type FillerMode =
  | "news"
  | "youtube"
  | "hum"
  | "off"
  | "fun-facts"
  | "calendar"
  | "quiet";

export interface VoiceChannelSnapshot {
  channel: Channel;
  previousChannel: Channel;
  /** Timestamp (ms) of the last turn in the session, or null. */
  lastActivityAt: number | null;
  /** Number of turns in the session, for "0" vs "new history" hints. */
  turnCount: number;
  /** Full turn list from the shared voice-session. Populated so the
   *  dashboard can render Telegram-driven conversation as it happens —
   *  the "read along on the phone" UX the relay architecture promises. */
  turns: VoiceTurnSnapshot[];
  /** YouTube filler selection, piggybacked on the same session poll.
   *  videoId=null means nothing is selected and TTS-news filler takes
   *  over. Non-null means the iframe hook should be running. */
  youtube: YouTubeFillerSnapshot;
  /** Currently-selected filler mode, read from
   *  telegram-voice/filler-config.json. Drives which audio source
   *  plays during thinking. */
  fillerMode: FillerMode;
}

const EMPTY_YT: YouTubeFillerSnapshot = {
  videoId: null,
  title: null,
  thumbnailUrl: null,
  durationSec: null,
  positionSec: 0,
  status: "idle",
  queue: [],
};

const EMPTY: VoiceChannelSnapshot = {
  channel: null,
  previousChannel: null,
  lastActivityAt: null,
  turnCount: 0,
  turns: [],
  youtube: EMPTY_YT,
  fillerMode: "news",
};

function normaliseFillerMode(raw: unknown): FillerMode {
  if (
    raw === "news" ||
    raw === "youtube" ||
    raw === "hum" ||
    raw === "off" ||
    raw === "fun-facts" ||
    raw === "calendar" ||
    raw === "quiet"
  ) {
    return raw;
  }
  return "news";
}

export function useVoiceChannel(
  // 100 ms — the user repeatedly reported hearing a full sentence of
  // laptop TTS after the phone picked up. Even with Python's
  // acquire-on-connect notification firing server-side the instant
  // the call becomes non-idle, the browser still has to notice. At
  // 100 ms the perceived bleed is below the threshold of irritation,
  // and the endpoint is in-memory on localhost — 10 requests/sec is
  // free. A lower interval has diminishing returns once you account
  // for audio-element pause latency (~5 ms).
  pollMs: number = 100,
): VoiceChannelSnapshot {
  const [snap, setSnap] = useState<VoiceChannelSnapshot>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/api/telegram/session", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          session: {
            channel: Channel;
            previousChannel: Channel;
            lastActivityAt: number;
            turns: VoiceTurnSnapshot[];
          } | null;
          youtube?: {
            videoId: string | null;
            title: string | null;
            thumbnailUrl: string | null;
            durationSec: number | null;
            positionSec: number;
            status: string;
            queue?: Array<{
              videoId: string;
              title: string | null;
              thumbnailUrl: string | null;
              durationSec: number | null;
            }>;
          };
          fillerMode?: unknown;
        };
        if (cancelled) return;
        const youtube: YouTubeFillerSnapshot = body.youtube
          ? {
              videoId: body.youtube.videoId ?? null,
              title: body.youtube.title ?? null,
              thumbnailUrl: body.youtube.thumbnailUrl ?? null,
              durationSec: body.youtube.durationSec ?? null,
              positionSec: body.youtube.positionSec ?? 0,
              status: body.youtube.status ?? "idle",
              queue: Array.isArray(body.youtube.queue)
                ? body.youtube.queue
                    .filter((q) => q && typeof q.videoId === "string")
                    .map((q) => ({
                      videoId: q.videoId,
                      title: q.title ?? null,
                      thumbnailUrl: q.thumbnailUrl ?? null,
                      durationSec: q.durationSec ?? null,
                    }))
                : [],
            }
          : EMPTY_YT;
        const fillerMode = normaliseFillerMode(body.fillerMode);
        if (!body.session) {
          setSnap({ ...EMPTY, youtube, fillerMode });
          return;
        }
        setSnap({
          channel: body.session.channel,
          previousChannel: body.session.previousChannel,
          lastActivityAt: body.session.lastActivityAt,
          turnCount: body.session.turns.length,
          turns: body.session.turns,
          youtube,
          fillerMode,
        });
      } catch {
        /* network blip — next tick */
      }
    }
    void tick();
    const iv = window.setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [pollMs]);

  return snap;
}
