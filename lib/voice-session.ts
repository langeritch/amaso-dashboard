/**
 * In-memory voice-session store.
 *
 * There is ONE session per user. It lives across channel switches —
 * the Telegram call, a Spar call, a dashboard chat turn: all of them
 * read from and append to the same object. Channel changes are like
 * picking up a headset vs. putting the phone on speaker. The session
 * isn't "ended" by a hang-up; it just goes to channel=null and
 * anyone can continue it on any channel.
 *
 * Staleness: if nothing touches the session for STALE_TTL_MS, the
 * next caller gets a fresh session. 30 min is long enough that
 * stepping away from the dashboard and then calling on Telegram
 * ("continue where I left off") works, but short enough that a
 * day-later call doesn't dredge up stale context.
 *
 * Scope on purpose — single-process, in-memory, not persisted. A
 * server restart drops the session, which is the right behaviour
 * (mid-call restarts are catastrophic anyway and mid-idle restarts
 * clear a context the user was about to forget about too).
 */

// Imported as a namespace so the channel-transition helpers below
// can flip YouTube's activeOutput in lockstep with the channel
// itself. Two-way decoupled: voice-session owns the channel, this
// module just mirrors it onto the YT state row that Python reads.
import * as yt from "./youtube-state";

export type VoiceTurn = {
  role: "user" | "assistant";
  text: string;
  /** Wall-clock timestamp in ms. */
  at: number;
  /** Which channel delivered this turn. The session as a whole moves
   *  between channels; individual turns remember where they came from
   *  so the transcript can label them. */
  channel: VoiceChannel;
};

export type VoiceChannel = "spar" | "telegram" | "chat";

export interface VoiceSession {
  id: string;
  userId: number;
  /** Active audio/input channel. null → nobody holds the line right
   *  now, but the session and its history persist. */
  channel: VoiceChannel | null;
  /** The channel that was active immediately before the current one.
   *  Drives the UI "continued from Spar" chip after a take-over. */
  previousChannel: VoiceChannel | null;
  createdAt: number;
  lastActivityAt: number;
  turns: VoiceTurn[];
}

const STALE_TTL_MS = 30 * 60 * 1000;

const sessions = new Map<number, VoiceSession>();

/**
 * Per-user registry of in-flight stream aborters, keyed by channel.
 * The Spar route registers its AbortController at stream start; when
 * the session's channel flips to another channel (e.g. Telegram
 * picks up mid-reply) we abort the previous channel's stream so the
 * two don't race each other into the shared session.
 */
const activeStreams = new Map<number, Map<VoiceChannel, AbortController>>();

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isStale(session: VoiceSession): boolean {
  return Date.now() - session.lastActivityAt > STALE_TTL_MS;
}

/** Returns the user's session if one exists and isn't stale. */
export function getSession(userId: number): VoiceSession | null {
  const session = sessions.get(userId);
  if (!session) return null;
  if (isStale(session)) {
    sessions.delete(userId);
    return null;
  }
  return session;
}

/**
 * Get the existing session (if any and fresh), or mint a new one
 * on the requested channel. Does NOT change the active channel of
 * an existing session — use `activateChannel` for that.
 */
export function getOrCreate(
  userId: number,
  channel: VoiceChannel | null,
): VoiceSession {
  const existing = getSession(userId);
  if (existing) return existing;
  const now = Date.now();
  const session: VoiceSession = {
    id: randomId(),
    userId,
    channel,
    previousChannel: null,
    createdAt: now,
    lastActivityAt: now,
    turns: [],
  };
  sessions.set(userId, session);
  return session;
}

/**
 * Mark a channel as the active one. If the session already had a
 * different channel active, the old one is recorded as
 * previousChannel (so the UI can surface "continued from Spar").
 * Returns `{ tookOver: true }` only when a channel switch happened;
 * activating the same channel twice is a no-op.
 *
 * Hand-off semantics: when Telegram acquires while Spar is mid-
 * generation, we deliberately do NOT abort the Spar stream. The
 * Spar finally block detects the channel flip, appends the reply,
 * and pushes it to the phone via /speak so the caller hears the
 * answer they were already waiting on. Aborting here was the cause
 * of remarks #70/#72 — mid-thinking responses were dropped on the
 * floor whenever the phone rang. The opposite direction (a fresh
 * Spar acquiring while Telegram is mid-reply) still aborts, since
 * the user explicitly switching back to dashboard signals they want
 * a new turn — see `abortOtherStreams` comment for the rule.
 */
export function activateChannel(
  userId: number,
  channel: VoiceChannel,
): { session: VoiceSession; tookOver: boolean } {
  const session = getOrCreate(userId, channel);
  let tookOver = false;
  if (session.channel !== channel) {
    if (session.channel !== null) {
      session.previousChannel = session.channel;
      tookOver = true;
    }
    session.channel = channel;
    abortOtherStreams(userId, channel);
  }
  session.lastActivityAt = Date.now();
  // Mirror the channel onto YouTube's activeOutput so the Python
  // filler manager (and the dashboard's resume logic) can tell who's
  // currently emitting audio. Done here rather than at the call-site
  // so every channel transition stays in lockstep — there's exactly
  // one place that flips this field.
  if (channel === "telegram") {
    yt.setActiveOutput(userId, "telegram");
  } else if (channel === "spar" || channel === "chat") {
    yt.setActiveOutput(userId, "dashboard");
  }
  return { session, tookOver };
}

/**
 * Bind an AbortController to the user's active stream on a channel.
 * Callers MUST call `unregisterStreamAbort` in their finally block
 * so a completed stream doesn't leak its controller into a future
 * take-over check.
 */
export function registerStreamAbort(
  userId: number,
  channel: VoiceChannel,
  controller: AbortController,
): void {
  let byChannel = activeStreams.get(userId);
  if (!byChannel) {
    byChannel = new Map();
    activeStreams.set(userId, byChannel);
  }
  byChannel.set(channel, controller);
}

export function unregisterStreamAbort(
  userId: number,
  channel: VoiceChannel,
  controller: AbortController,
): void {
  const byChannel = activeStreams.get(userId);
  if (!byChannel) return;
  // Only remove if it's still the same controller — defensive against
  // a newer stream having overwritten the slot before we finalised.
  if (byChannel.get(channel) === controller) byChannel.delete(channel);
  if (byChannel.size === 0) activeStreams.delete(userId);
}

/**
 * Abort streams owned by channels that are losing the line.
 *
 * Asymmetric on purpose:
 *   - Telegram acquiring while Spar is generating → keep Spar
 *     alive. Its finally block will hand the finished reply off to
 *     the phone via /speak. Aborting was the bug behind remarks
 *     #70/#72 (mid-thinking response dropped on call pickup).
 *   - Spar (dashboard) re-acquiring while Telegram is mid-reply →
 *     abort Telegram. The user touched the dashboard mic; whatever
 *     the phone was generating is no longer the conversation they
 *     want to hear, and continuing it would race a fresh Spar turn
 *     into the same session.
 *   - Chat acquiring → abort whichever was holding (typed turns
 *     replace voice mid-stream, same rationale as Spar).
 *
 * If we ever add a third audio channel that also wants graceful
 * hand-off semantics, extend the keep-alive set rather than the
 * abort set — silently dropping a generated response is the harder
 * bug to notice in the wild.
 */
function abortOtherStreams(userId: number, keep: VoiceChannel): void {
  const byChannel = activeStreams.get(userId);
  if (!byChannel) return;
  for (const [chan, controller] of byChannel) {
    if (chan === keep) continue;
    // Hand-off case: Telegram is taking over and Spar has a stream
    // in flight. Let Spar's finally block deliver the reply through
    // the phone instead of nuking the controller mid-token.
    if (keep === "telegram" && chan === "spar") continue;
    try {
      controller.abort();
    } catch {
      /* aborting twice is a no-op; swallow everything else */
    }
  }
}

/**
 * Release the current channel (e.g. call hung up, Spar stream
 * finished). The session itself is preserved so the next channel
 * can continue it.
 */
export function releaseChannel(userId: number): VoiceSession | null {
  const session = sessions.get(userId);
  if (!session) return null;
  if (session.channel !== null) {
    session.previousChannel = session.channel;
    session.channel = null;
  }
  session.lastActivityAt = Date.now();
  // Drop activeOutput to "none" — neither side is currently emitting
  // audio. We deliberately don't auto-set "dashboard" because the
  // user may want silence after a call ends. The next /play call
  // (browser or Python) is what re-claims it.
  yt.setActiveOutput(userId, "none");
  return session;
}

/**
 * Append a turn. Creates the session on-demand on the given channel
 * if none exists — safer for write-through patterns (Spar, chat)
 * than requiring callers to pre-create.
 */
export function appendTurn(
  userId: number,
  channel: VoiceChannel,
  role: VoiceTurn["role"],
  text: string,
): VoiceSession {
  const session = getOrCreate(userId, channel);
  const at = Date.now();
  session.turns.push({ role, text, at, channel });
  session.lastActivityAt = at;
  return session;
}
