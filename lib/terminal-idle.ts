// Auto-report trigger for the spar pipeline.
//
// The trigger is a working→at_prompt state transition on the worker
// (the same state machine the workers panel renders). The 5-second
// idle timer that drove this in earlier versions was abandoned because
// it false-positived during Claude Code's initialisation pause — bytes
// flowed for a moment, fell silent for >5 s before the first real tool
// call, and the timer fired before any actual work happened.
//
// New mechanism:
//   1. armIdle() flips `awaitingResponse` true on a CR/LF user-submit
//      and stashes the userId. State detection from this point on runs
//      against this session.
//   2. noteActivity() (called from terminal-backend's chunk subscriber)
//      consults detectWorkerState() on every incoming chunk. When the
//      session is in `thinking`, mark `hasSeenWorking = true`.
//   3. Once we've seen `thinking` AND the current state is `at_prompt`
//      (i.e. visible last line is a `\w+ed for Ns` completion or just
//      a bare prompt), schedule a 1.5 s settle timer. If the state is
//      still non-thinking when the timer fires, we fire the auto-
//      report. A flip back to `thinking` during the settle (Claude
//      starting another tool) cancels and we wait for the next at_prompt.
//   4. `permission_gate` and `awaiting_input` explicitly never fire —
//      both mean Claude is waiting on the user, not done with work.
//
// Stage 1 of remark #285 keys this state by sessionId; sessionId
// === projectId for every existing call site, so behaviour is the
// same as pre-refactor.

import { getProject } from "./config";
import { pushToUsers } from "./push";
import { markDispatchCompleted } from "./spar-dispatch";
import { runProactiveTurn } from "./spar-proactive";
import { detectWorkerState } from "./terminal-state";
import { listSessionsForProject } from "./terminal-backend";
import { broadcastDispatchCompleted, hasSparUserSocket } from "./ws";

// How long to wait after observing a non-thinking state before firing.
// Absorbs the ~0.5–1 s gaps Claude leaves between tool calls without
// letting the state look "done" for long enough to false-positive.
const SETTLE_MS = 1_500;

interface IdleState {
  /** Project this session belongs to. */
  projectId: string;
  /** True once a CR/LF was submitted for this dispatch and we're
   *  waiting on the worker to finish. Cleared after fireIdle() runs. */
  awaitingResponse: boolean;
  notifyUserId: number | null;
  /** True once detectWorkerState has reported `thinking` since the
   *  last arm. Required before we'll fire — it's what filters out
   *  Claude Code's initialisation pause where bytes flow but no real
   *  work is happening yet. */
  hasSeenWorking: boolean;
  /** Pending settle-timer when we've observed at_prompt. Cleared
   *  if the state flips back to thinking before the timer fires. */
  settleTimer: NodeJS.Timeout | null;
  /** Wall-clock of the last armIdle() — surfaces in diagnostic logs
   *  so we can see how long a dispatch ran before completing. */
  armedAt: number | null;
  /** True once noteActivity has run since the last arm. Logged once
   *  per cycle so diagnostic output stays readable. */
  firstActivitySeen: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoTerminalIdle: Map<string, IdleState> | undefined;
}

function states(): Map<string, IdleState> {
  if (!globalThis.__amasoTerminalIdle) {
    globalThis.__amasoTerminalIdle = new Map();
  }
  return globalThis.__amasoTerminalIdle;
}

function resolveSessionId(projectId: string, sessionId?: string): string {
  return sessionId ?? projectId;
}

function getOrCreate(sessionId: string, projectId: string): IdleState {
  const map = states();
  let s = map.get(sessionId);
  if (!s) {
    s = {
      projectId,
      awaitingResponse: false,
      notifyUserId: null,
      hasSeenWorking: false,
      settleTimer: null,
      armedAt: null,
      firstActivitySeen: false,
    };
    map.set(sessionId, s);
  } else {
    s.projectId = projectId;
  }
  return s;
}

function clearSettle(s: IdleState): void {
  if (s.settleTimer) {
    clearTimeout(s.settleTimer);
    s.settleTimer = null;
  }
}

/** Arm the idle watcher. Called from terminal-backend.write() when a
 *  CR/LF lands with a known userId. After this, the next
 *  thinking→at_prompt transition fires the auto-report. */
export function armIdle(
  projectId: string,
  userId: number | null,
  sessionId?: string,
): void {
  const sid = resolveSessionId(projectId, sessionId);
  const s = getOrCreate(sid, projectId);
  const wasArmed = s.awaitingResponse;
  s.awaitingResponse = true;
  if (userId != null) s.notifyUserId = userId;
  s.armedAt = Date.now();
  s.firstActivitySeen = false;
  s.hasSeenWorking = false;
  clearSettle(s);
  console.log(
    `[idle] armed session=${sid} project=${projectId} user=${s.notifyUserId} reArm=${wasArmed} (waiting for thinking→at_prompt)`,
  );
}

/**
 * Post-restart recovery hook. Called from terminal-backend.init() after
 * a dashboard cycle so dispatches that were in flight when we went
 * down still produce an auto-report. The new state-transition design
 * makes this simpler than the old timer-immediate path: just arm and
 * run an immediate state check. If the session is already showing a
 * completion line, fire now. Otherwise the next chunk's noteActivity
 * picks up where we left off.
 */
export function armIdleWithImmediateTimer(
  projectId: string,
  userId: number | null,
  sessionId?: string,
): void {
  const sid = resolveSessionId(projectId, sessionId);
  armIdle(projectId, userId, sid);
  // Immediate state probe so we don't have to wait for the next chunk.
  // Lazy import to dodge the cycle (terminal-backend → terminal-idle →
  // terminal-backend).
  void (async () => {
    try {
      const { getSession } = await import("./terminal-backend");
      const session = getSession(projectId, sid);
      if (!session) return;
      const detection = detectWorkerState(
        session.scrollback,
        sid,
        session.startedAt,
      );
      if (detection.state === "thinking") {
        // Still working — let the regular noteActivity path drive the
        // transition when it eventually flips.
        const s = states().get(sid);
        if (s) s.hasSeenWorking = true;
        console.log(
          `[idle] post-restart recovery session=${sid} — still thinking, waiting for completion`,
        );
        return;
      }
      // Not thinking. Treat the dispatch as already complete; fire now.
      // hasSeenWorking is forced true so the gating in fireIdle passes
      // (we missed the visible working state because the dashboard was
      // down while it happened).
      const s = states().get(sid);
      if (!s) return;
      s.hasSeenWorking = true;
      console.log(
        `[idle] post-restart recovery session=${sid} — state=${detection.state}, firing immediately`,
      );
      fireIdle(sid);
    } catch (err) {
      console.warn(
        `[idle] post-restart probe failed for session=${sid}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  })();
}

/** Called from the data subscriber attached in terminal-backend on
 *  every chunk. Runs detectWorkerState against the live scrollback,
 *  tracks whether we've ever been in `thinking`, and fires the auto-
 *  report on the working→at_prompt transition (after a settle). */
export function noteActivity(projectId: string, sessionId?: string): void {
  const sid = resolveSessionId(projectId, sessionId);
  const s = states().get(sid);
  if (!s || !s.awaitingResponse) return;
  if (!s.firstActivitySeen) {
    s.firstActivitySeen = true;
    const waited = s.armedAt ? Date.now() - s.armedAt : 0;
    console.log(
      `[idle] first chunk after arm session=${sid} project=${projectId} waited=${waited}ms`,
    );
  }

  // Lazy import to dodge the cycle. Guard against the partial-init race:
  // if terminal-backend is still being initialised when the first data
  // chunk fires, require() returns an incomplete module and getSession is
  // undefined — calling it would throw "TypeError: s is not a function"
  // and crash the server. Returning early is safe: noteActivity() runs on
  // every chunk, so we'll get another chance on the very next byte.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSession } = require("./terminal-backend") as typeof import("./terminal-backend");
  if (typeof getSession !== "function") return;
  const session = getSession(projectId, sid);
  if (!session) return;
  const detection = detectWorkerState(
    session.scrollback,
    sid,
    session.startedAt,
  );

  if (detection.state === "thinking") {
    s.hasSeenWorking = true;
    // If we'd previously scheduled a fire and Claude started thinking
    // again, cancel the settle — clearly not done.
    if (s.settleTimer) {
      clearSettle(s);
      console.log(
        `[idle] cancelled settle session=${sid} — flipped back to thinking`,
      );
    }
    return;
  }

  if (detection.state === "permission_gate" || detection.state === "awaiting_input") {
    // Worker is blocked on a human, not done. Don't fire and don't
    // schedule. Cancel any pending settle so a previous "looked done"
    // stretch doesn't ride this through.
    if (s.settleTimer) clearSettle(s);
    return;
  }

  // detection.state === "at_prompt" (or "unknown"). Only meaningful if
  // we previously saw thinking — otherwise this is the init pause and
  // any "completion" line is residual from a previous turn.
  if (!s.hasSeenWorking) return;
  if (s.settleTimer) return; // already scheduled, let it resolve

  s.settleTimer = setTimeout(() => {
    s.settleTimer = null;
    // Re-check at fire time — Claude may have started thinking again.
    const session2 = getSession(projectId, sid);
    if (!session2) return;
    const recheck = detectWorkerState(
      session2.scrollback,
      sid,
      session2.startedAt,
    );
    if (recheck.state === "thinking") {
      console.log(
        `[idle] settle fired but session=${sid} is thinking again — re-arming`,
      );
      return;
    }
    if (recheck.state === "permission_gate" || recheck.state === "awaiting_input") {
      console.log(
        `[idle] settle fired but session=${sid} is ${recheck.state} — not done`,
      );
      return;
    }
    fireIdle(sid);
  }, SETTLE_MS);
  console.log(
    `[idle] worker non-thinking session=${sid} state=${detection.state} — settling for ${SETTLE_MS}ms`,
  );
}

/** Called on session exit. Drops the per-session state so a future
 *  start() under the same id begins clean. */
export function cancelIdle(projectId: string, sessionId?: string): void {
  const sid = resolveSessionId(projectId, sessionId);
  const s = states().get(sid);
  if (!s) return;
  clearSettle(s);
  states().delete(sid);
}

/** True when at least one session for `projectId` is mid-dispatch
 *  (armed, waiting on output). Lets project-level callers — e.g. spar
 *  dispatch routing in Stage 2 — answer "is anyone busy on this
 *  project?" without iterating sessions themselves. */
export function isAnySessionBusyForProject(projectId: string): boolean {
  for (const s of states().values()) {
    if (s.projectId === projectId && s.awaitingResponse) return true;
  }
  return false;
}

/** True when this specific session is mid-dispatch. Used by the Stage 2
 *  dispatch resolver to pick an idle session over a working one when
 *  multiple are alive for the same project. Sessions that have never
 *  been dispatched-to (manual user typing only) read false here, which
 *  is the right answer — they're available. */
export function isSessionBusy(sessionId: string): boolean {
  return states().get(sessionId)?.awaitingResponse === true;
}

function fireIdle(sessionId: string): void {
  const s = states().get(sessionId);
  if (!s) return;
  clearSettle(s);
  if (!s.awaitingResponse) {
    console.log(`[idle] fireIdle session=${sessionId} bailed (awaitingResponse=false)`);
    return;
  }
  s.awaitingResponse = false;
  const userId = s.notifyUserId;
  if (userId == null) {
    console.log(`[idle] fireIdle session=${sessionId} bailed (notifyUserId=null)`);
    return;
  }
  const projectId = s.projectId;
  const project = getProject(projectId);
  const name = project?.name ?? projectId;
  // Stage 3: compute the session's 1-based ordinal among the project's
  // currently-live sessions (oldest-first), matching the convention the
  // worker-status route + WorkerStatusPanel use. Pure presentation —
  // surfaces "session #2" in the auto-report bubble when more than one
  // is alive. Snapshot at fire-time so the label can't drift even if
  // siblings spawn / exit between the broadcast and the user reading
  // the bubble.
  const liveSessions = listSessionsForProject(projectId).sort(
    (a, b) => a.startedAt - b.startedAt,
  );
  const ordinalIdx = liveSessions.findIndex((x) => x.sessionId === sessionId);
  const sessionOrdinal = ordinalIdx >= 0 ? ordinalIdx + 1 : 0;
  const projectSessionCount = liveSessions.length;
  console.log(
    `[idle] fireIdle session=${sessionId} project=${projectId} user=${userId} name=${name} ordinal=${sessionOrdinal}/${projectSessionCount}`,
  );

  // If this idle followed a spar-dispatched prompt, mark it complete
  // so the spar UI can auto-report back without the user asking. No-op
  // when the user typed the prompt themselves — there's no pending
  // dispatch log entry to update. Stage 3 passes sessionId so the
  // resolver picks the right pending entry when multiple sessions
  // for the same project have queued dispatches.
  let completedDispatchId: string | null = null;
  try {
    const completed = markDispatchCompleted(userId, projectId, sessionId);
    completedDispatchId = completed?.id ?? null;
  } catch (err) {
    console.warn(`[idle] markDispatchCompleted threw for project=${projectId}:`, err);
  }
  console.log(
    `[idle] markDispatchCompleted result project=${projectId} session=${sessionId} dispatchId=${completedDispatchId ?? "<none>"}`,
  );

  if (completedDispatchId) {
    try {
      // Only forward the session pair when the project actually has
      // multiple live sessions — single-session dispatches keep the
      // pre-Stage-3 wire shape, so legacy clients see no change.
      const includeSession = projectSessionCount > 1;
      broadcastDispatchCompleted(
        userId,
        projectId,
        name,
        completedDispatchId,
        includeSession ? sessionId : undefined,
        includeSession ? sessionOrdinal : undefined,
      );
    } catch (err) {
      console.warn(
        `[idle] broadcastDispatchCompleted threw for project=${projectId}:`,
        err,
      );
    }
  }

  // If the user has a spar tab open, the SparProvider's queueCompletion
  // path will produce the in-conversation summary itself (Opus quality,
  // voice-mode aware). We still send the basic push here so the phone
  // / locked-screen still buzzes. If NO tab is open, hand off to the
  // server-side proactive turn — it generates a Haiku summary, persists
  // an assistant message in the conversation, and sends a richer push
  // with the actual summary as the body.
  const tabOpen = hasSparUserSocket(userId);
  // Disambiguate the push notification body when the project has
  // multiple live sessions — the user otherwise can't tell which one
  // just finished from the lock screen.
  const pushBody =
    projectSessionCount > 1 && sessionOrdinal > 0
      ? `${name} #${sessionOrdinal} wacht op je.`
      : `${name} wacht op je.`;
  if (tabOpen || !completedDispatchId) {
    void pushToUsers([userId], {
      title: "Claude is klaar",
      body: pushBody,
      url: `/projects/${encodeURIComponent(projectId)}`,
      // Per-session push tag so two sessions finishing back-to-back
      // each get their own notification instead of one collapsing on
      // top of the other. Falls back to project-only when we don't
      // have an ordinal (single-session case).
      tag:
        projectSessionCount > 1 && sessionOrdinal > 0
          ? `claude-idle-${projectId}-${sessionOrdinal}`
          : `claude-idle-${projectId}`,
      data: { projectId, sessionId, sessionOrdinal },
    });
    return;
  }

  console.log(
    `[idle] no spar tab for user=${userId} — running server-side proactive summary for project=${projectId} session=${sessionId}`,
  );
  void runProactiveTurn({
    kind: "dispatch_complete",
    userId,
    projectId,
    sessionId,
    sessionOrdinal: projectSessionCount > 1 ? sessionOrdinal : undefined,
    projectSessionCount,
    dispatchId: completedDispatchId,
  }).catch((err) => {
    console.warn(
      `[idle] proactive turn threw for project=${projectId} session=${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}
