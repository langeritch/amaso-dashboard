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
import { readAutopilotDirective } from "./autopilot";
import {
  appendMessage,
  createConversation,
  latestConversationId,
} from "./spar-conversations";
import { detectWorkerState } from "./terminal-state";
import { listSessionsForProject } from "./terminal-backend";
import { broadcastDispatchCompleted, broadcastSparMessage } from "./ws";

// How long to wait after observing a non-thinking state before firing.
// Absorbs the ~0.5–1 s gaps Claude leaves between tool calls without
// letting the state look "done" for long enough to false-positive.
const SETTLE_MS = 1_500;

// Loop guard for the auto-report nudge.
//
// After fireIdle drops a "check output of terminal for X" message for
// project P into spar, suppress further auto-reports FOR THAT SAME
// PROJECT for AUTO_REPORT_COOLDOWN_MS. Other projects firing their
// completions during the window get through unimpeded — the loop
// case we're guarding against is "P fires AR → AI dispatches into P
// → P finishes → AR → loop", which is per-project by construction.
// Twelve unrelated projects all completing in a one-second burst
// should produce twelve auto-reports (merged client-side into one
// model turn), not one project's report and eleven dropped on the
// floor.
//
// Cooldown key is `${userId}:${projectId}` so two operators in the
// same workspace each get independent windows per project.
const AUTO_REPORT_COOLDOWN_MS = 90_000;
const autoReportCooldownUntil = new Map<string, number>();

function cooldownKey(userId: number, projectId: string): string {
  return `${userId}:${projectId}`;
}

function isAutoReportCooldownActive(
  userId: number,
  projectId: string,
): boolean {
  const key = cooldownKey(userId, projectId);
  const until = autoReportCooldownUntil.get(key);
  if (until == null) return false;
  if (until <= Date.now()) {
    autoReportCooldownUntil.delete(key);
    return false;
  }
  return true;
}

function startAutoReportCooldown(userId: number, projectId: string) {
  autoReportCooldownUntil.set(
    cooldownKey(userId, projectId),
    Date.now() + AUTO_REPORT_COOLDOWN_MS,
  );
}

// Server-side nudge batching. When many terminals finish within a short
// window (blast test, parallel dispatches), collect completions per
// user and flush as ONE merged spar message instead of N individual
// ones. Each new arrival resets the timer so a steady drip during the
// window still merges; flush only fires once the user goes quiet for
// NUDGE_BATCH_MS. The per-project cooldown above continues to gate
// the loop case independently — the batch keys cooldown START off the
// flush, not the queue, so a project that arrives mid-window is still
// added to its merged turn before its own cooldown latches.
const NUDGE_BATCH_MS = 5_000;

interface PendingNudge {
  projectId: string;
  sessionId: string;
  completedDispatchId: string;
  sessionLabel: string;
  /** Full text of the dispatch prompt that just finished. Captured at
   *  fireIdle time from markDispatchCompleted's returned entry, then
   *  surfaced inline in the merged nudge so the model can decide
   *  success/failure + match the right open remark without first having
   *  to look it up. Empty string when the dispatch row vanished. */
  prompt: string;
}

const pendingNudgesByUser = new Map<number, PendingNudge[]>();
const nudgeBatchTimers = new Map<number, ReturnType<typeof setTimeout>>();

function queueNudge(userId: number, nudge: PendingNudge) {
  let queue = pendingNudgesByUser.get(userId);
  if (!queue) {
    queue = [];
    pendingNudgesByUser.set(userId, queue);
  }
  queue.push(nudge);
  console.log(
    `[idle] queueNudge user=${userId} project=${nudge.projectId} session=${nudge.sessionId} ` +
      `dispatch=${nudge.completedDispatchId} promptLen=${nudge.prompt.length} ` +
      `pendingCount=${queue.length} timerArmed=${NUDGE_BATCH_MS}ms`,
  );
  // (Re)start the batch timer so late arrivals extend the window —
  // a 5 s drip with one completion per second still produces one
  // merged message at the end, not five separate ones.
  const existing = nudgeBatchTimers.get(userId);
  if (existing) clearTimeout(existing);
  nudgeBatchTimers.set(
    userId,
    setTimeout(() => flushNudgeBatch(userId), NUDGE_BATCH_MS),
  );
}

// Hard ceiling on a single auto-report nudge message. When the merged
// nudge (boilerplate + label list + "Last sent prompts" bullets) would
// exceed this, splitNudgesIntoChunks splits the projects across
// multiple sequential messages instead of dumping one wall of text.
// Picked to comfortably fit a typical 5-12 project burst without
// chunking, while keeping any one chunk readable as a chat bubble.
const NUDGE_MAX_CHARS = 1500;

// Delay between sequential chunk emissions for the same user. Long
// enough that the client-side merge window (~50 ms) won't recombine
// them, short enough that the operator perceives them as one event.
const NUDGE_CHUNK_DELAY_MS = 250;

function buildNudgeMessage(
  chunk: PendingNudge[],
  customInstructions: string,
): string {
  const labels: string[] = [];
  for (const n of chunk) {
    if (!labels.includes(n.sessionLabel)) labels.push(n.sessionLabel);
  }
  const labelList = labels.join(", ");
  const perProject =
    labels.length === 1
      ? "Read the terminal"
      : "For each project, read the terminal";

  // One bullet per project carrying the FULL prompt text that just
  // finished. The model uses these to decide success/failure and to
  // match the right open remark in the queue without having to grep
  // recent dispatches itself.
  const promptLines: string[] = [];
  for (const n of chunk) {
    if (n.prompt && n.prompt.trim().length > 0) {
      promptLines.push(`- ${n.sessionLabel}: ${n.prompt.trim()}`);
    }
  }
  const promptBlock =
    promptLines.length > 0
      ? `\n\nLast sent prompts:\n${promptLines.join("\n")}`
      : "";

  // User-set custom instructions ride along on EVERY auto-report,
  // basic or smart mode alike. Stored in `autopilot_users.directive`
  // (legacy field name; surfaces in the UI as "Custom instructions").
  // The smart-mode autopilot block also reads the same value as a
  // strategic directive — the Auto-report sidebar makes that single
  // source of truth explicit.
  const trimmedInstructions = customInstructions.trim();
  const instructionsBlock =
    trimmedInstructions.length > 0
      ? `\n\nCustom instructions:\n${trimmedInstructions}`
      : "";

  return (
    `Check the output of terminal for ${labelList}. ` +
    `${perProject} to see if the dispatched task finished successfully. ` +
    `If it did, resolve any open remark that matches the task ` +
    `using resolve_remark.${promptBlock}${instructionsBlock}`
  );
}

// Greedy packer: walks the nudges in arrival order, accumulating
// projects into a chunk until adding the next project would push the
// rendered message past NUDGE_MAX_CHARS. A single project whose own
// prompt already exceeds the limit becomes its own chunk (we can't
// split a single dispatch — it's atomic). Order is preserved so the
// chat reads in the same sequence the terminals finished.
function splitNudgesIntoChunks(
  nudges: PendingNudge[],
  customInstructions: string,
): PendingNudge[][] {
  if (nudges.length === 0) return [];
  if (buildNudgeMessage(nudges, customInstructions).length <= NUDGE_MAX_CHARS)
    return [nudges];

  const chunks: PendingNudge[][] = [];
  let current: PendingNudge[] = [];
  for (const n of nudges) {
    const candidate = [...current, n];
    if (
      current.length > 0 &&
      buildNudgeMessage(candidate, customInstructions).length > NUDGE_MAX_CHARS
    ) {
      chunks.push(current);
      current = [n];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function emitNudgeChunk(
  userId: number,
  chunk: PendingNudge[],
  customInstructions: string,
): void {
  const nudge = buildNudgeMessage(chunk, customInstructions);

  const toolCalls =
    chunk.length === 1
      ? {
          kind: "auto_report" as const,
          projectId: chunk[0].projectId,
          sessionId: chunk[0].sessionId,
          completedDispatchId: chunk[0].completedDispatchId,
        }
      : {
          kind: "auto_report" as const,
          projects: chunk.map((n) => ({
            projectId: n.projectId,
            sessionId: n.sessionId,
            completedDispatchId: n.completedDispatchId,
          })),
        };

  try {
    let conversationId = latestConversationId(userId);
    const wasFresh = conversationId == null;
    if (conversationId == null) {
      conversationId = createConversation(userId, null).id;
    }
    console.log(
      `[idle] emitNudgeChunk user=${userId} chunkSize=${chunk.length} ` +
        `nudgeLen=${nudge.length} conversationId=${conversationId} ` +
        `wasFresh=${wasFresh} firstProject=${chunk[0]?.projectId}`,
    );
    const row = appendMessage({
      conversationId,
      userId,
      role: "user",
      content: nudge,
      toolCalls,
    });
    if (!row) {
      console.warn(
        `[idle] emitNudgeChunk user=${userId} appendMessage returned null — ` +
          `nudge NOT persisted (chunk=${chunk.length} conv=${conversationId})`,
      );
      return;
    }
    console.log(
      `[idle] emitNudgeChunk user=${userId} appended messageId=${row.id} conv=${row.conversationId}`,
    );
    // Cooldown latches per project once the chunk lands. With
    // chunking, a project's cooldown starts on the chunk that
    // carried it — chunks for the same flush still happen within
    // a few hundred ms of each other, so the loop guard's 90 s
    // window covers the whole sequence.
    for (const n of chunk) {
      startAutoReportCooldown(userId, n.projectId);
    }
    try {
      broadcastSparMessage(userId, {
        conversationId: row.conversationId,
        message: {
          id: row.id,
          role: row.role,
          content: row.content,
          toolCalls: row.toolCalls,
          createdAt: row.createdAt,
        },
      });
      console.log(
        `[idle] emitNudgeChunk user=${userId} broadcast OK messageId=${row.id}`,
      );
    } catch (err) {
      console.warn(
        `[idle] emitNudgeChunk broadcast failed for messageId=${row.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  } catch (err) {
    console.warn(
      `[idle] nudge chunk append failed for ${chunk.length} projects:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function flushNudgeBatch(userId: number) {
  console.log(`[idle] flushNudgeBatch fired user=${userId}`);
  nudgeBatchTimers.delete(userId);
  const nudges = pendingNudgesByUser.get(userId);
  pendingNudgesByUser.delete(userId);
  if (!nudges || nudges.length === 0) {
    console.log(`[idle] flushNudgeBatch user=${userId} bailed (queue empty)`);
    return;
  }

  // Pull the user's custom instructions once per flush so every chunk
  // in this batch carries the same trailing block. Reading inside the
  // loop would race a mid-flush directive edit and produce chunks that
  // disagree with each other.
  let customInstructions = "";
  try {
    customInstructions = readAutopilotDirective(userId);
  } catch (err) {
    console.warn(
      `[idle] readAutopilotDirective threw for user=${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const chunks = splitNudgesIntoChunks(nudges, customInstructions);
  console.log(
    `[idle] flushNudgeBatch user=${userId} nudges=${nudges.length} chunks=${chunks.length} ` +
      `instructionsLen=${customInstructions.length}`,
  );

  // Emit chunks sequentially with a short delay between them. The first
  // fires immediately; subsequent chunks are scheduled relative to the
  // batch's flush instant so the spacing is deterministic regardless of
  // how long each appendMessage / broadcast takes. The delay must stay
  // above the client-side merge window in SparProvider (~50 ms) so the
  // chunks land as separate auto-report turns instead of being re-glued
  // back into one giant prompt.
  chunks.forEach((chunk, idx) => {
    if (idx === 0) {
      emitNudgeChunk(userId, chunk, customInstructions);
    } else {
      setTimeout(
        () => emitNudgeChunk(userId, chunk, customInstructions),
        idx * NUDGE_CHUNK_DELAY_MS,
      );
    }
  });
}

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
  let completedPrompt = "";
  try {
    const completed = markDispatchCompleted(userId, projectId, sessionId);
    completedDispatchId = completed?.id ?? null;
    completedPrompt = completed?.prompt ?? "";
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

  // Push so the phone / locked-screen buzzes regardless of tab state.
  const pushBody =
    projectSessionCount > 1 && sessionOrdinal > 0
      ? `${name} #${sessionOrdinal} wacht op je.`
      : `${name} wacht op je.`;
  void pushToUsers([userId], {
    title: "Claude is klaar",
    body: pushBody,
    url: `/projects/${encodeURIComponent(projectId)}`,
    tag:
      projectSessionCount > 1 && sessionOrdinal > 0
        ? `claude-idle-${projectId}-${sessionOrdinal}`
        : `claude-idle-${projectId}`,
    data: { projectId, sessionId, sessionOrdinal },
  });

  // No-op when this idle wasn't a spar dispatch (manual user typing
  // straight into a terminal shouldn't litter the spar transcript).
  if (!completedDispatchId) return;

  // Loop guard. If THIS project's previous auto-report response
  // triggered the sparring partner to dispatch another task INTO THE
  // SAME PROJECT, that task's completion would land here within
  // seconds and try to fire its own auto-report — restarting the
  // loop the original Haiku-driven design fell into. The cooldown
  // stops the chain at depth 1, scoped per project so a parallel
  // completion in some other project still gets through.
  if (isAutoReportCooldownActive(userId, projectId)) {
    console.log(
      `[idle] auto-report cooldown active for user=${userId} project=${projectId} — suppressing nudge session=${sessionId} dispatch=${completedDispatchId}`,
    );
    return;
  }

  // Hand off to the per-user batch buffer. The actual spar message
  // (and its WS broadcast) lands when flushNudgeBatch fires after
  // NUDGE_BATCH_MS of quiet — a 12-terminal blast becomes one
  // merged "check output of terminals for A, B, …, L" row instead
  // of twelve separate ones in the chat.
  const sessionLabel =
    projectSessionCount > 1 && sessionOrdinal > 0
      ? `${projectId} session #${sessionOrdinal}`
      : projectId;
  queueNudge(userId, {
    projectId,
    sessionId,
    completedDispatchId,
    sessionLabel,
    prompt: completedPrompt,
  });
}
