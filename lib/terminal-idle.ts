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

import { isAutopilotEnabled } from "./autopilot";
import { getProject, projectTerminalAutoReportEnabled } from "./config";
import { pushToUsers } from "./push";
import {
  findPendingDispatchForSession,
  markDispatchCompleted,
} from "./spar-dispatch";
import {
  appendMessage,
  createConversation,
  latestConversationId,
} from "./spar-conversations";
import { detectWorkerState } from "./terminal-state";
import { listSessionsForProject } from "./terminal-backend";
import { broadcastDispatchCompleted, broadcastSparMessage } from "./ws";
import { tryClaimAutoReport } from "./spar-autoreport-dedupe";

// How long to wait after observing a non-thinking state before firing.
// Absorbs the ~0.5–1 s gaps Claude leaves between tool calls without
// letting the state look "done" for long enough to false-positive.
const SETTLE_MS = 1_500;

// Byte-silence fallback path. When the terminal is not running Claude
// Code (no braille-spinner OSC title → detectWorkerState never returns
// "thinking" → hasSeenWorking never flips), we still want an auto-report
// after any user-armed command goes quiet. Runs in parallel with the
// Claude state machine; whichever fires first wins. Because Claude's
// settle is 1.5s and byte-silence is 10s, Claude always wins when its
// title is being painted. The byte threshold filters trivial commands
// (cd, short echo, clean `git status`) that arm but produce no
// meaningful output the operator would want a chat ping about.
const BYTE_SILENCE_QUIET_MS = Math.max(
  1_000,
  Number(process.env.AMASO_AUTOREPORT_QUIET_MS ?? "10000"),
);
const BYTE_SILENCE_MIN_BYTES = Math.max(
  0,
  Number(process.env.AMASO_AUTOREPORT_MIN_BYTES ?? "200"),
);

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
  /** Dispatch row this nudge was tied to, when the working→idle cycle
   *  was triggered by a spar dispatch. Null when the cycle came from
   *  the user typing directly into the terminal — the nudge still
   *  fires (workers-sidebar lifecycle), just without a dispatch id to
   *  cross-reference. */
  completedDispatchId: string | null;
  /** Human-readable worker name (project name, plus "#N" suffix when
   *  the project has multiple live sessions). Surfaces verbatim inside
   *  the `Check terminal "<sessionLabel>" in this chat` line. */
  sessionLabel: string;
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
      `dispatch=${nudge.completedDispatchId ?? "<none>"} label=${nudge.sessionLabel} ` +
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

// Hard ceiling on a single auto-report nudge message. With the new
// minimal copy each worker contributes ~45-60 chars, so a 1500-char
// budget comfortably holds 25+ workers per chunk before splitting.
const NUDGE_MAX_CHARS = 1500;

// Delay between sequential chunk emissions for the same user. Long
// enough that the client-side merge window (~50 ms) won't recombine
// them, short enough that the operator perceives them as one event.
const NUDGE_CHUNK_DELAY_MS = 250;

// One pointer line per worker. Singular completion renders as exactly
// one line; concurrent completions get newline-stacked so the operator
// sees every worker that just flipped to idle without scrolling. No
// summary, no result blurb, no last-prompt block, no custom instructions
// — the message is the pointer, not the recap.
//
// Autopilot-off branches to a more explicit wording so Santi knows the
// project is done and waiting on him directly (no autonomous loop will
// pick it up). Autopilot-on keeps the original pointer wording — the
// autonomous-loop side of that branch is handled in a follow-up.
function buildNudgeMessage(chunk: PendingNudge[], userId: number): string {
  const autopilotOn = isAutopilotEnabled(userId);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const n of chunk) {
    if (seen.has(n.sessionLabel)) continue;
    seen.add(n.sessionLabel);
    if (autopilotOn) {
      lines.push(`Check terminal "${n.sessionLabel}" in this chat`);
    } else {
      lines.push(`${n.sessionLabel} is done. Autopilot is off — waiting on you.`);
    }
  }
  return lines.join("\n");
}

// Greedy packer: walks the nudges in arrival order, accumulating
// workers into a chunk until adding the next would push the rendered
// message past NUDGE_MAX_CHARS. Order is preserved so the chat reads
// in the same sequence the terminals finished.
function splitNudgesIntoChunks(
  nudges: PendingNudge[],
  userId: number,
): PendingNudge[][] {
  if (nudges.length === 0) return [];
  if (buildNudgeMessage(nudges, userId).length <= NUDGE_MAX_CHARS) return [nudges];

  const chunks: PendingNudge[][] = [];
  let current: PendingNudge[] = [];
  for (const n of nudges) {
    const candidate = [...current, n];
    if (
      current.length > 0 &&
      buildNudgeMessage(candidate, userId).length > NUDGE_MAX_CHARS
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

function emitNudgeChunk(userId: number, chunk: PendingNudge[]): void {
  const nudge = buildNudgeMessage(chunk, userId);

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

  // Cross-emitter dedupe (see lib/spar-autoreport-dedupe.ts). Claim
  // BEFORE chunking so the whole batch shares one slot — multi-chunk
  // batches must not self-collide. Loss means task-agent already
  // posted a completion summary covering the same root cause; drop
  // the nudge before persist + broadcast. The ref uses dispatch id
  // when present, otherwise the session id of the first nudge so
  // manually-typed cycles (no dispatch row) still dedupe cleanly.
  const refBase =
    nudges[0].completedDispatchId ?? `session:${nudges[0].sessionId}`;
  const dedupeRef =
    refBase + (nudges.length > 1 ? `+${nudges.length - 1}more` : "");
  if (!tryClaimAutoReport(userId, { ref: dedupeRef, source: "terminal-idle" })) {
    return;
  }

  const chunks = splitNudgesIntoChunks(nudges, userId);
  console.log(
    `[idle] flushNudgeBatch user=${userId} nudges=${nudges.length} chunks=${chunks.length}`,
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
      emitNudgeChunk(userId, chunk);
    } else {
      setTimeout(() => emitNudgeChunk(userId, chunk), idx * NUDGE_CHUNK_DELAY_MS);
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
  /** Bytes of terminal output observed since the last fresh arm.
   *  Drives the byte-silence fallback path: if at least
   *  BYTE_SILENCE_MIN_BYTES have flowed and chunks stop for
   *  BYTE_SILENCE_QUIET_MS, the auto-report fires even without the
   *  Claude state-machine transition. Reset only on fresh arms so
   *  re-arms (paste bodies, parallel writers) accumulate. */
  bytesSinceArm: number;
  /** Count of chunks observed since the last fresh arm. Purely
   *  diagnostic — logged when byte-silence fires so we can tell
   *  "one big chunk" from "lots of trickling output". */
  chunkCount: number;
  /** Debounce timer for the byte-silence fallback. (Re)scheduled on
   *  every incoming chunk; fires fireIdleByteSilence when chunks
   *  stop landing for BYTE_SILENCE_QUIET_MS. Cleared on settle,
   *  fireIdle, and cancelIdle so it can't race the Claude path. */
  quietTimer: NodeJS.Timeout | null;
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
      bytesSinceArm: 0,
      chunkCount: 0,
      quietTimer: null,
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

function clearQuiet(s: IdleState): void {
  if (s.quietTimer) {
    clearTimeout(s.quietTimer);
    s.quietTimer = null;
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
  // Only stamp notifyUserId on a FRESH arm. Re-arms during an in-flight
  // dispatch (paste body \n, delayed \r, watchdog retry, OR an unrelated
  // user typing in the same project's terminal viewer) must not clobber
  // the original dispatcher — fireIdle still falls back through the
  // dispatch log for the authoritative dispatcher id, but keeping the
  // in-memory pointer pinned to the original writer makes the manual-
  // typing path (no dispatch log entry) behave intuitively too.
  if (userId != null && !wasArmed) s.notifyUserId = userId;
  s.armedAt = Date.now();
  // Reset the per-cycle observation flags only on a FRESH arm. Re-arming
  // during an ongoing dispatch must not forget that we already observed
  // `thinking` — otherwise the worker→at_prompt transition that follows
  // bails silently because hasSeenWorking is false again.
  if (!wasArmed) {
    s.firstActivitySeen = false;
    s.hasSeenWorking = false;
    s.bytesSinceArm = 0;
    s.chunkCount = 0;
    clearSettle(s);
    clearQuiet(s);
  }
  console.log(
    `[idle] armed session=${sid} project=${projectId} user=${s.notifyUserId} reArm=${wasArmed} hasSeenWorking=${s.hasSeenWorking} (waiting for thinking→at_prompt or ${BYTE_SILENCE_QUIET_MS}ms byte silence)`,
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
 *  report on the working→at_prompt transition (after a settle).
 *
 *  `chunkBytes` is the size of the chunk that triggered this call. Used
 *  to drive the byte-silence fallback path so non-Claude commands (raw
 *  shells, npm, build scripts) still produce a nudge when they finish.
 *  Optional for back-compat with any caller that doesn't pass it; in
 *  that case the byte path is effectively disabled (no chunks counted)
 *  and the Claude state-machine path remains the only trigger. */
export function noteActivity(
  projectId: string,
  sessionId?: string,
  chunkBytes?: number,
): void {
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

  // Byte-silence fallback. Accumulate bytes since arm and (re)schedule
  // the quiet timer on every chunk so the timer fires only after
  // BYTE_SILENCE_QUIET_MS of dead air. Runs in parallel with the
  // Claude state machine below; whichever fires first wins. The
  // hasSeenWorking gate inside fireIdleByteSilence prevents a
  // double-fire when both paths converge on the same cycle.
  if (typeof chunkBytes === "number" && chunkBytes > 0) {
    s.bytesSinceArm += chunkBytes;
    s.chunkCount += 1;
    clearQuiet(s);
    s.quietTimer = setTimeout(
      () => fireIdleByteSilence(sid),
      BYTE_SILENCE_QUIET_MS,
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
    const flipped = !s.hasSeenWorking;
    s.hasSeenWorking = true;
    if (flipped) {
      console.log(`[idle] saw thinking session=${sid} — hasSeenWorking=true`);
    }
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
    if (s.settleTimer) {
      clearSettle(s);
      console.log(
        `[idle] cancelled settle session=${sid} — state=${detection.state}`,
      );
    }
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
  clearQuiet(s);
  states().delete(sid);
}

/** Fallback trigger for non-Claude terminals. Called when the byte-
 *  silence quiet timer elapses without a new chunk landing. Suppressed
 *  when the Claude state machine is active (hasSeenWorking=true) — the
 *  1.5s settle path already handles those cycles and a parallel fire
 *  would race for the same dispatch. Also gated by a minimum-output
 *  threshold so trivial commands (cd, short echo, clean git status)
 *  don't spam the operator's spar chat. */
function fireIdleByteSilence(sessionId: string): void {
  const s = states().get(sessionId);
  if (!s) return;
  s.quietTimer = null;
  if (!s.awaitingResponse) {
    console.log(
      `[idle] byte-silence noop session=${sessionId} — awaitingResponse=false (already fired)`,
    );
    return;
  }
  if (s.hasSeenWorking) {
    // Claude state machine took over since the timer was scheduled.
    // Let its settle path do the firing so we don't double-emit.
    console.log(
      `[idle] byte-silence skipped session=${sessionId} — Claude state-machine active (hasSeenWorking=true)`,
    );
    return;
  }
  if (s.bytesSinceArm < BYTE_SILENCE_MIN_BYTES) {
    console.log(
      `[idle] byte-silence below threshold session=${sessionId} bytes=${s.bytesSinceArm}/${BYTE_SILENCE_MIN_BYTES} chunks=${s.chunkCount} — skipping trivial command`,
    );
    return;
  }
  console.log(
    `[idle] byte-silence fired session=${sessionId} bytes=${s.bytesSinceArm} chunks=${s.chunkCount} quietMs=${BYTE_SILENCE_QUIET_MS}`,
  );
  fireIdle(sessionId);
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
  clearQuiet(s);
  if (!s.awaitingResponse) {
    console.log(`[idle] fireIdle session=${sessionId} bailed (awaitingResponse=false)`);
    return;
  }
  s.awaitingResponse = false;
  const projectId = s.projectId;
  // Prefer the durable dispatch log over the in-memory notifyUserId: any
  // `\r`/`\n` writeTerminal call (user B typing in the same project's
  // terminal viewer while user A's dispatch is in flight) stamps
  // notifyUserId with whoever wrote last, so the auto-report would land
  // in the wrong user's spar chat. The dispatch log entry is keyed to
  // the original dispatcher and survives the in-memory clobber.
  const pendingForSession = findPendingDispatchForSession(projectId, sessionId);
  const userId = pendingForSession?.userId ?? s.notifyUserId;
  if (userId == null) {
    console.log(`[idle] fireIdle session=${sessionId} bailed (notifyUserId=null)`);
    return;
  }
  if (pendingForSession && pendingForSession.userId !== s.notifyUserId) {
    console.log(
      `[idle] fireIdle session=${sessionId} routing to dispatcher=${pendingForSession.userId} ` +
        `(in-memory notifyUserId=${s.notifyUserId} was clobbered by an unrelated writer)`,
    );
  }
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

  // Feature flag gate — when the project-terminal auto-report chat
  // message is disabled, bail BEFORE the cooldown latches and BEFORE
  // queueNudge so the spar transcript stays clean. Everything above
  // still runs (push, dispatch ack); only the chat-bubble path is gated.
  if (!projectTerminalAutoReportEnabled()) {
    console.log(
      `[idle] auto-report disabled by feature flag — skipping nudge for user=${userId} project=${projectId} session=${sessionId}`,
    );
    return;
  }

  // Loop guard. If THIS project's previous auto-report response
  // triggered the sparring partner to dispatch another task INTO THE
  // SAME PROJECT, that task's completion would land here within
  // seconds and try to fire its own auto-report — restarting the
  // loop the original Haiku-driven design fell into. The cooldown
  // stops the chain at depth 1, scoped per project so a parallel
  // completion in some other project still gets through.
  if (isAutoReportCooldownActive(userId, projectId)) {
    console.log(
      `[idle] auto-report cooldown active for user=${userId} project=${projectId} — suppressing nudge session=${sessionId}`,
    );
    return;
  }

  // Hand off to the per-user batch buffer. Fires for EVERY working→idle
  // cycle — dispatch-armed or not — so the workers sidebar lifecycle
  // (manually-typed prompts as well as dispatched ones) produces the
  // pointer line in spar chat. The label uses the human-readable
  // project name plus a "#N" suffix when multiple sessions exist for
  // the same project, so the operator can pick the right terminal.
  const sessionLabel =
    projectSessionCount > 1 && sessionOrdinal > 0
      ? `${name} #${sessionOrdinal}`
      : name;
  queueNudge(userId, {
    projectId,
    sessionId,
    completedDispatchId,
    sessionLabel,
  });
}
