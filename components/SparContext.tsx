"use client";

import { createContext, useContext, type RefObject } from "react";

export type Role = "user" | "assistant";
export type Msg = { id: number; role: Role; content: string };

export type DispatchStatus = "sent" | "failed";
export type Dispatch = {
  id: string;
  projectId: string;
  prompt: string;
  status: DispatchStatus;
  confirmedAt: number;
  completedAt: number | null;
  error: string | null;
};

export const MAX_TRANSCRIPT = 30;

export type SparUser = { id: number; name: string; email: string };

export type YoutubeQueueItem = {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
};

export type YoutubeNowPlaying = {
  videoId: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  positionSec: number;
  /** "idle" | "playing" | "paused" — server's intent for this slot. */
  status: "idle" | "playing" | "paused";
};

/**
 * Unified "what's audible right now" status, derived inside
 * SparProvider from the existing filler decision tree. The mini-
 * player consumes this to render a single status indicator that
 * covers every audio source — not just YouTube.
 */
export type FillerNow =
  | {
      kind: "youtube";
      videoId: string;
      title: string | null;
      thumbnailUrl: string | null;
      /** Server intent (drives the play/pause button glyph). */
      status: "playing" | "paused";
    }
  | { kind: "news" }
  | { kind: "hum" }
  | { kind: "speaking" }
  | { kind: "listening" }
  | { kind: "thinking" }
  | {
      kind: "telegram";
      /** Live derived state of the Telegram call. Mirrors the same
       *  listening/thinking/speaking phases a dashboard call exposes,
       *  but inferred from the shared voice-session turn stream — the
       *  phone leg doesn't push frame-level mic/TTS flags into the
       *  dashboard, so the latest-turn role + age is the authoritative
       *  signal. Lets the mini-player and topbar render a live state
       *  badge during Telegram calls instead of a static "in call". */
      phase: "listening" | "thinking" | "speaking";
    }
  | { kind: "idle" };

export type SparContextValue = {
  // Identity
  currentUser: SparUser;
  canManageOthers: boolean;

  // Conversation state
  messages: Msg[];
  busy: boolean;
  interimText: string;
  status: string;

  // Call state
  inCall: boolean;
  /** Which audio channel currently owns the voice session, if any.
   *  Mirrors useVoiceChannel().channel so consumers (Topbar icon,
   *  badges) don't have to start their own poll loop. */
  voiceChannel: "spar" | "telegram" | "chat" | null;
  listening: boolean;
  micMuted: boolean;
  ttsMuted: boolean;
  ttsIdle: boolean;
  autopilot: boolean;
  callTimeLabel: string;

  // Dispatch mirror
  dispatches: Dispatch[];
  lastDispatch: Dispatch | null;

  // Heartbeat
  heartbeat: string;
  setHeartbeat: (v: string) => void;
  heartbeatDirty: boolean;
  setHeartbeatDirty: (v: boolean) => void;
  savingHeartbeat: boolean;
  speakingUserId: number;

  // Refs (audio analyser shared between full and mini visualizers)
  analyserRef: RefObject<AnalyserNode | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;

  // YouTube mini-player (reads server-side selection, drives controls)
  youtubeNowPlaying: YoutubeNowPlaying;
  youtubeQueue: YoutubeQueueItem[];
  youtubeVolume: number;
  setYoutubeVolume: (v: number) => void;
  youtubePlay: () => void;
  youtubePause: () => void;
  youtubeStop: () => void;
  /** Skip current track. Advances to the next queued track if any,
   *  otherwise behaves like youtubeStop. */
  youtubeSkip: () => void;
  /** Append a track to the queue. If nothing is currently playing,
   *  the server promotes it straight into now-playing. */
  youtubeEnqueue: (item: YoutubeQueueItem) => void;
  youtubeClearQueue: () => void;
  /** Drop a single queued track by videoId. No-op if the videoId
   *  isn't in the queue (server settles truth on the next poll). */
  youtubeRemoveFromQueue: (videoId: string) => void;
  /** Move a queued track from `fromIdx` to `toIdx` (indices over the
   *  queue, so 0 is the next-up item — the now-playing track is not
   *  part of it). Out-of-range / equal indices are clamped server-
   *  side, so callers can fire freely. */
  youtubeReorderQueue: (fromIdx: number, toIdx: number) => void;

  // Unified filler/audio status — covers YouTube, news, hum, speaking,
  // thinking, listening, telegram, idle. Drives the mini-player's
  // always-visible status indicator.
  fillerNow: FillerNow;

  // Actions
  startCall: (opts?: { resumedAt?: number }) => void;
  endCall: () => void;
  toggleMicMute: () => void;
  toggleTtsMute: () => void;
  toggleAutopilot: () => void;
  sendMessage: (raw: string, opts?: { kickoff?: boolean }) => Promise<void>;
  saveHeartbeat: () => Promise<void>;
  loadHeartbeatFor: (userId: number) => Promise<void>;
  clearTranscript: () => void;
};

export const SparContext = createContext<SparContextValue | null>(null);

export function useSpar(): SparContextValue {
  const ctx = useContext(SparContext);
  if (!ctx) {
    throw new Error("useSpar must be used inside <SparProvider>");
  }
  return ctx;
}

export function useSparOptional(): SparContextValue | null {
  return useContext(SparContext);
}
