/**
 * In-memory YouTube playback state, one record per user.
 *
 * Shape mirrors voice-session: single-process, non-persisted, stale
 * TTL. The MCP tools mutate this (youtube_play / youtube_stop); the
 * browser reads it through the existing 100 ms voice-session poll
 * (piggybacked on /api/telegram/session) and writes back position
 * updates through /api/youtube/state POST.
 *
 * The "filler decision" itself — whether to play right now — is NOT
 * owned here. The browser observes `busy && ttsIdle` locally and
 * uses *this* state only to answer "which video, and at what
 * position, when filler should play". That split keeps the
 * thinking-gate latency-free (no round-trip on every edge).
 */

export type YouTubePlaybackStatus = "playing" | "paused" | "idle";

/**
 * Which output is currently emitting the audio. Either side can read
 * this to decide whether it owns playback right now:
 *   - "dashboard": the browser iframe is the speaker. Python should
 *                  stay quiet (fall back to news for filler).
 *   - "telegram":  pytgcalls is the speaker. The dashboard pauses
 *                  its iframe and shows "on Telegram call" status.
 *   - "none":      no active YouTube playback right now (could be
 *                  paused, stopped, or simply nothing selected).
 *
 * Owned by the channel-acquire / release path in voice-session, with
 * a manual override for the "user paused on dashboard" case so we
 * don't flip back to "dashboard" when nobody's actually playing.
 */
export type YouTubeOutput = "dashboard" | "telegram" | "none";

/**
 * One pending track in the play queue. Same shape as the now-playing
 * fields below — mirroring the structure means the mini-player can
 * render the queue with the exact same ArtSlot/title rules.
 */
export interface YouTubeQueueItem {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
}

export interface YouTubeState {
  /** null when no video is selected ("idle" state). */
  videoId: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  /**
   * Tracks waiting to play after the current one. The head (index 0)
   * is the next track. Empty array means "nothing queued — playback
   * stops or stays silent after the current video ends."
   *
   * Mutated by enqueueYouTube (append), advanceYouTube (shift head
   * into now-playing), and clearYouTubeQueue. playYouTube preserves
   * the queue when the same video is replayed but clears it on a
   * fresh selection — explicit `play X` is interpreted as "this is
   * the new current track", not "shove it ahead of the queue".
   */
  queue: YouTubeQueueItem[];
  /**
   * Last-known playback position reported by whichever side is
   * playing. Resets to 0 on a new video. Allowed to lag the true
   * playhead by a few seconds — both browsers and the Python service
   * report on a coarse tick.
   *
   * During a Telegram call this is written by Python via
   * /api/youtube/state action=report_position. When the call ends,
   * the dashboard's resume logic reads this value back so playback
   * picks up where the call left off.
   */
  positionSec: number;
  /** Epoch ms when positionSec was last written. */
  positionReportedAt: number | null;
  /**
   * Server's intent:
   *   - "playing": should play during thinking windows
   *   - "paused":  user told us to pause — stay paused
   *   - "idle":    no video; fall back to TTS news filler
   */
  status: YouTubePlaybackStatus;
  /**
   * Which side is currently the audio emitter (or "none" when neither
   * is playing). Driven by the channel transitions in voice-session
   * — see `setActiveOutput` below.
   */
  activeOutput: YouTubeOutput;
  /** Epoch ms of the last server-side mutation. */
  updatedAt: number;
}

const STALE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — YouTube selections aren't precious

const states = new Map<number, YouTubeState>();

function freshState(): YouTubeState {
  return {
    videoId: null,
    title: null,
    thumbnailUrl: null,
    durationSec: null,
    queue: [],
    positionSec: 0,
    positionReportedAt: null,
    status: "idle",
    activeOutput: "none",
    updatedAt: Date.now(),
  };
}

function isStale(state: YouTubeState): boolean {
  return Date.now() - state.updatedAt > STALE_TTL_MS;
}

/**
 * Get the current state. Never returns null — absence means "idle";
 * the caller sees a coherent structure either way. Stale records
 * are cleared on read.
 */
export function getYouTubeState(userId: number): YouTubeState {
  const state = states.get(userId);
  if (!state || isStale(state)) {
    const fresh = freshState();
    states.set(userId, fresh);
    return fresh;
  }
  return state;
}

/**
 * Select a video and start playing (on the next thinking window).
 * Position resets to 0. If the same videoId was already loaded we
 * preserve its position — repeated play calls on the same video
 * mean "ensure it's playing", not "start over".
 */
export function playYouTube(
  userId: number,
  params: {
    videoId: string;
    title?: string | null;
    thumbnailUrl?: string | null;
    durationSec?: number | null;
  },
): YouTubeState {
  const existing = states.get(userId);
  const now = Date.now();
  const sameVideo = existing?.videoId === params.videoId;
  const state: YouTubeState = {
    videoId: params.videoId,
    title: params.title ?? (sameVideo ? existing!.title : null),
    thumbnailUrl:
      params.thumbnailUrl ?? (sameVideo ? existing!.thumbnailUrl : null),
    durationSec:
      params.durationSec ?? (sameVideo ? existing!.durationSec : null),
    // Preserve the queue across same-video replays — a re-play call
    // is "make sure this is playing", not "wipe what's lined up next".
    // A fresh video swap, on the other hand, drops the old queue: it's
    // clearer than implicitly putting the previous queue behind the
    // new track, and matches how most music apps behave when the user
    // explicitly picks something to play right now.
    queue: sameVideo ? existing!.queue : [],
    positionSec: sameVideo ? existing!.positionSec : 0,
    positionReportedAt: sameVideo ? existing!.positionReportedAt : null,
    status: "playing",
    // Preserve the prior activeOutput when we already had a record —
    // a /play call from the browser shouldn't accidentally hand
    // playback to the dashboard if Telegram was already holding the
    // line. The channel-transition path (setActiveOutput) is the
    // authoritative knob for this field.
    activeOutput: sameVideo ? existing!.activeOutput : "none",
    updatedAt: now,
  };
  states.set(userId, state);
  return state;
}

/**
 * Pause the current video without forgetting it. No-op if nothing
 * is selected. Position is preserved so the next /play resumes.
 */
export function pauseYouTube(userId: number): YouTubeState {
  const existing = states.get(userId);
  if (!existing || !existing.videoId) {
    const fresh = freshState();
    states.set(userId, fresh);
    return fresh;
  }
  const next: YouTubeState = {
    ...existing,
    status: "paused",
    updatedAt: Date.now(),
  };
  states.set(userId, next);
  return next;
}

/**
 * Clear the selection entirely. Next thinking window falls back to
 * TTS news filler. Also drops the queue — a stop is a hard reset.
 */
export function stopYouTube(userId: number): YouTubeState {
  const fresh = freshState();
  states.set(userId, fresh);
  return fresh;
}

/**
 * Append a track to the play queue. If nothing is currently selected
 * we promote the first enqueued item straight into now-playing instead
 * of leaving the user with a queue and no current track — matches the
 * obvious mental model of "queue this" when nothing is playing.
 */
export function enqueueYouTube(
  userId: number,
  item: YouTubeQueueItem,
): YouTubeState {
  const existing = states.get(userId) ?? freshState();
  const now = Date.now();
  if (!existing.videoId) {
    // Nothing playing — promote into now-playing. Status flips to
    // "playing" so the iframe hook actually picks it up; the channel
    // transition logic in voice-session owns activeOutput, so we
    // leave that field alone.
    const next: YouTubeState = {
      ...existing,
      videoId: item.videoId,
      title: item.title,
      thumbnailUrl: item.thumbnailUrl,
      durationSec: item.durationSec,
      queue: existing.queue,
      positionSec: 0,
      positionReportedAt: null,
      status: "playing",
      updatedAt: now,
    };
    states.set(userId, next);
    return next;
  }
  // Same-video guard: don't enqueue the currently-playing track or a
  // duplicate of an already-queued one. Rare in practice but keeps
  // the visible list tidy when a tool spam-enqueues "lo-fi beats".
  const alreadyHere =
    existing.videoId === item.videoId ||
    existing.queue.some((q) => q.videoId === item.videoId);
  if (alreadyHere) {
    states.set(userId, existing);
    return existing;
  }
  const next: YouTubeState = {
    ...existing,
    queue: [...existing.queue, item],
    updatedAt: now,
  };
  states.set(userId, next);
  return next;
}

/**
 * Remove a single track from the queue by videoId. Idempotent —
 * removing a videoId that isn't queued is a silent no-op (useful
 * when the UI fires a remove on a row that just got auto-advanced
 * server-side). Doesn't touch the currently-playing video; if the
 * caller wants to skip the head they should hit advance instead.
 */
export function removeFromQueue(userId: number, videoId: string): YouTubeState {
  const existing = states.get(userId) ?? freshState();
  const target = videoId.trim();
  if (!target) {
    states.set(userId, existing);
    return existing;
  }
  const idx = existing.queue.findIndex((q) => q.videoId === target);
  if (idx < 0) {
    states.set(userId, existing);
    return existing;
  }
  const next: YouTubeState = {
    ...existing,
    queue: existing.queue.filter((_, i) => i !== idx),
    updatedAt: Date.now(),
  };
  states.set(userId, next);
  return next;
}

/**
 * Move a queued track from one position to another. Indices are
 * over the *queue* (the now-playing track isn't part of it), so
 * fromIdx=0 is the next-up item. Out-of-range / equal indices are
 * clamped/ignored — the UI's up/down arrows can fire freely without
 * pre-validating, and the server settles the truth.
 */
export function reorderQueue(
  userId: number,
  fromIdx: number,
  toIdx: number,
): YouTubeState {
  const existing = states.get(userId) ?? freshState();
  const len = existing.queue.length;
  if (len < 2) {
    states.set(userId, existing);
    return existing;
  }
  const from = Math.max(0, Math.min(len - 1, Math.floor(fromIdx)));
  const to = Math.max(0, Math.min(len - 1, Math.floor(toIdx)));
  if (from === to) {
    states.set(userId, existing);
    return existing;
  }
  const reordered = [...existing.queue];
  const [picked] = reordered.splice(from, 1);
  reordered.splice(to, 0, picked);
  const next: YouTubeState = {
    ...existing,
    queue: reordered,
    updatedAt: Date.now(),
  };
  states.set(userId, next);
  return next;
}

/**
 * Drop the queue without touching the currently playing video.
 */
export function clearYouTubeQueue(userId: number): YouTubeState {
  const existing = states.get(userId) ?? freshState();
  if (existing.queue.length === 0) {
    states.set(userId, existing);
    return existing;
  }
  const next: YouTubeState = {
    ...existing,
    queue: [],
    updatedAt: Date.now(),
  };
  states.set(userId, next);
  return next;
}

/**
 * Skip the current track. If the queue has at least one item, that
 * item becomes the new now-playing track and is removed from the
 * queue. Empty queue → falls back to stopYouTube semantics (clear
 * selection so the news filler kicks in). Drives both the manual
 * skip button and the iframe's auto-advance on ENDED.
 */
export function advanceYouTube(userId: number): YouTubeState {
  const existing = states.get(userId) ?? freshState();
  if (existing.queue.length === 0) {
    // Nothing queued — same effect as stop. We fully reset rather
    // than leaving a stale paused selection lying around.
    return stopYouTube(userId);
  }
  const [head, ...rest] = existing.queue;
  const now = Date.now();
  const next: YouTubeState = {
    ...existing,
    videoId: head.videoId,
    title: head.title,
    thumbnailUrl: head.thumbnailUrl,
    durationSec: head.durationSec,
    queue: rest,
    positionSec: 0,
    positionReportedAt: null,
    status: "playing",
    updatedAt: now,
  };
  states.set(userId, next);
  return next;
}

/**
 * Write-through of the current playhead. Both the browser iframe and
 * the Python service hit this path: during a dashboard session the
 * useYoutubeFiller hook reports every 2 s; during a Telegram call
 * the Python filler manager reports every 5 s. The handover works
 * because both paths target the same row, so whichever side hangs
 * up second leaves a fresh enough position for the other to resume
 * from.
 *
 * Does NOT change status — a pause decision is the user's, not the
 * reporter's.
 */
export function reportPosition(userId: number, positionSec: number): YouTubeState {
  const existing = states.get(userId) ?? freshState();
  const next: YouTubeState = {
    ...existing,
    positionSec: Math.max(0, positionSec),
    positionReportedAt: Date.now(),
    // Do NOT bump updatedAt — position reports aren't mutations.
  };
  states.set(userId, next);
  return next;
}

/**
 * Flip the activeOutput field. Driven by activateChannel /
 * releaseChannel in voice-session — when the call channel goes to
 * "telegram" we set "telegram" here so Python can claim playback;
 * when the call ends we drop back to "none" until the dashboard
 * resumes (it'll then echo "dashboard" via its own play call). We
 * deliberately don't auto-set "dashboard" on releaseChannel because
 * the user might just want silence.
 *
 * Idempotent — same-value calls are a no-op (returns existing state
 * without bumping updatedAt) so we don't churn the poll cache.
 */
export function setActiveOutput(
  userId: number,
  output: YouTubeOutput,
): YouTubeState {
  const existing = states.get(userId) ?? freshState();
  if (existing.activeOutput === output) {
    states.set(userId, existing);
    return existing;
  }
  const next: YouTubeState = {
    ...existing,
    activeOutput: output,
    updatedAt: Date.now(),
  };
  states.set(userId, next);
  return next;
}
