"use client";

import { createContext, useContext, type RefObject } from "react";

export type Role = "user" | "assistant";

/**
 * One step the agent took inside its tool-using loop. Each step
 * starts as `{ status: "running" }` when the model emits the
 * tool_use, then flips to `{ status: "ok" | "error", summary }` when
 * the matching tool_result arrives. Rendered inline in the chat as a
 * subtle card so the user can watch the agent think and act in real
 * time. Steps belong to whichever assistant message is currently
 * streaming — they live on Msg.steps, not in a sidebar, so the
 * conversation reads top-to-bottom in causal order.
 */
export type ToolStepStatus = "running" | "ok" | "error";
export type ToolStep = {
  /** Pairs the tool_use with its tool_result. */
  id: string;
  /** Human verb-noun phrase ("Reading terminal output"). */
  label: string;
  /** Optional context fragment ("for badkamerstijl"). */
  detail: string;
  status: ToolStepStatus;
  /** One-line result summary. Set when status flips off "running". */
  summary?: string;
  startedAt: number;
  completedAt?: number;
};

export type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
};

export type Msg = {
  id: number;
  role: Role;
  content: string;
  startedAt?: number;
  completedAt?: number;
  steps?: ToolStep[];
  attachments?: Attachment[];
  /** Human-readable list of sources consulted while building this
   *  reply: the always-injected baseline (CLAUDE.md, MEMORY.md,
   *  heartbeat, user profile, hard-won solutions) plus any read-shape
   *  tool the agent invoked during the turn. Populated only on
   *  assistant messages — undefined elsewhere. */
  sources?: string[];
  /** Server-side spar_messages.id once the row has been persisted.
   *  Used to dedupe own-tab WS broadcasts against the optimistic
   *  message we already added locally — when the cross-device push
   *  echoes back, we attach this id instead of inserting a duplicate. */
  persistedId?: number;
  /** True when this user-role bubble was inserted by the auto-report
   *  path (a dispatched terminal finished and SparProvider.sendSystemInjection
   *  injected a friendly "Update on X — what happened?" prompt) rather
   *  than typed by the human. Drives the "Auto-report" badge on the
   *  bubble in SparFullView. Session-only — not persisted server-side,
   *  so on reload the badge disappears (the bubble itself stays). */
  isAutoReport?: boolean;
};

export type SparConversationSummary = {
  id: number;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string | null;
  /** Soft "this thread has drifted" suggestion produced by the
   *  server-side drift detector. Rendered as a dismissible banner in
   *  the chat view; null when nothing's flagged. */
  driftNotice: string | null;
};

export type DispatchStatus = "sent" | "failed";
export type Dispatch = {
  id: string;
  projectId: string;
  /** Stage 3: which terminal session received this dispatch. Equals
   *  projectId for legacy / single-session entries; absent on rows
   *  saved before the field was introduced. The polling fallback in
   *  SparProvider forwards this through queueCompletion so an auto-
   *  report that arrives via the polling path (WS missed it) can
   *  still attribute itself to the correct session. */
  sessionId?: string;
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

/** A single news clip in the upcoming-news list. Same shape as the
 *  /api/filler/clips response — surfaced into the mini-player so the
 *  user can see what's queued whether it's YouTube or news. */
export type NewsQueueItem = {
  id: string;
  title: string | null;
  source: string | null;
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
  | {
      kind: "news";
      /** Clip id (sha1 hash). null in the brief inter-clip gap. */
      clipId: string | null;
      /** Headline title from the sidecar JSON. null when unknown
       *  (older clip without a sidecar) — the mini-player falls back
       *  to a generic "News headline" label. */
      title: string | null;
      /** Source label (e.g. "BBC News Middle East"). */
      source: string | null;
      /** True when the user has paused the news stream. The clip
       *  stays decoded so a subsequent resume picks up mid-story. */
      paused: boolean;
    }
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

  // News mini-player — exposed so the same UI that drives YouTube
  // can drive news playback. Pause/resume/skip are user-facing
  // transport controls; the upcoming list lets the expanded card
  // mirror the YouTube up-next layout.
  newsUpcoming: NewsQueueItem[];
  /** Pause the currently-playing news clip in place. The clip stays
   *  decoded so resume picks up mid-headline. */
  newsPause: () => void;
  /** Resume from the saved offset (or start the next clip if none). */
  newsResume: () => void;
  /** Drop the current clip and advance to the next. */
  newsSkip: () => void;
  /** True when the news pool will be the next thing to play once
   *  YouTube goes idle (queue empty or filler-config flipped). The
   *  YouTube queue UI uses this to render a virtual "News" trailer
   *  at the end of the up-next list. */
  newsUpNextAfterYoutube: boolean;

  // Persistent conversation state — drives the sidebar thread list
  // and cross-device sync. activeConversationId is null while the
  // current local transcript hasn't been pinned to a server row yet
  // (e.g. brand-new tab before the user has typed anything). The
  // server lazily creates the row on the first persistable turn and
  // emits its id back over the stream, at which point this state
  // catches up.
  conversations: SparConversationSummary[];
  activeConversationId: number | null;
  loadingConversation: boolean;
  selectConversation: (id: number) => Promise<void>;
  newConversation: () => void;
  deleteConversation: (id: number) => Promise<void>;
  refreshConversations: () => Promise<void>;
  /** Drift hint for the active conversation (or null). Driven by the
   *  server-side drift detector and by WS broadcasts. */
  activeDriftNotice: string | null;
  /** Clear the drift hint locally and tell the server to forget it. */
  dismissDriftNotice: () => Promise<void>;

  // Actions
  startCall: (opts?: { resumedAt?: number }) => void;
  endCall: () => void;
  toggleMicMute: () => void;
  toggleTtsMute: () => void;
  toggleAutopilot: () => void;
  pendingAttachments: Attachment[];
  addAttachments: (files: File[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  sendMessage: (
    raw: string,
    opts?: {
      kickoff?: boolean;
      skipUserBubble?: boolean;
      skipPersistLastUser?: boolean;
    },
  ) => Promise<boolean>;
  /** Outbound message queue. User-typed drafts submitted while busy
   *  AND auto-report nudges from terminal-idle land here; the
   *  provider's drain effect pops the head and fires sendMessage when
   *  the model is idle and TTS has finished. */
  messageQueue: Array<{
    id: number;
    text: string;
    opts?: { skipUserBubble?: boolean; skipPersistLastUser?: boolean };
  }>;
  /** Append text (and optional sendMessage opts) to the queue. Returns
   *  the new entry's id so the caller can edit / remove it later. */
  enqueueMessage: (
    text: string,
    opts?: { skipUserBubble?: boolean; skipPersistLastUser?: boolean },
  ) => number;
  /** Pop a queued entry by id and return its text (the page UI uses
   *  this to drop the entry back into the composer for editing). */
  editQueuedMessage: (id: number) => string | null;
  /** Drop a queued entry without sending. */
  removeQueuedMessage: (id: number) => void;
  saveHeartbeat: () => Promise<void>;
  loadHeartbeatFor: (userId: number) => Promise<void>;
  clearTranscript: () => void;
  /** Append a local-only assistant notice to the transcript. Used by
   *  client-side slash commands (e.g. /youtube) to surface confirmation
   *  without round-tripping through the model. */
  appendNotice: (content: string) => void;
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
