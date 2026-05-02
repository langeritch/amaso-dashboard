// Routing layer between the in-process PTY backend (`./terminal`) and the
// remote amaso-pty-service backend (`./pty-client`).
//
// Stage 1 of the multi-terminal refactor (remark #285): every public
// function takes `projectId` plus an optional `sessionId`. When sessionId
// is omitted (every existing call site), it defaults to projectId — the
// current one-session-per-project behaviour is preserved bit-for-bit.
// Stage 2 introduces real per-spawn ids and the helpers callers need to
// pick one (most-recently-idle, spawn-new, …).
//
// All call sites that previously imported from `./terminal` should now
// import from here. When `ptyServiceUrl` is empty (the default), every
// function delegates to `./terminal` unchanged. When the URL is set, the
// remote client takes over.
//
// The toggle is checked per-call so that flipping the env var at runtime
// (a `kill -HUP`-style soft restart isn't needed) takes effect on the
// next operation. Existing in-flight sessions on the side that's no
// longer routed continue running until they exit naturally.

import * as local from "./terminal";
import * as remote from "./pty-client";
import { getPtyServiceUrl } from "./config";
import {
  armIdle,
  armIdleWithImmediateTimer,
  cancelIdle,
  noteActivity,
} from "./terminal-idle";

export type TerminalStatus = local.TerminalStatus;

// Per-session subscription to the active backend's data stream. Used to
// drive idle detection (push notification + spar auto-report broadcast)
// at the wrapper level so behaviour is identical across backends. Keyed
// by sessionId; populated lazily on start() / write(); cleared by the
// session-exit callback the subscriber installs.
declare global {
  // eslint-disable-next-line no-var
  var __amasoTerminalObservers: Map<string, () => void> | undefined;
}

function observers(): Map<string, () => void> {
  if (!globalThis.__amasoTerminalObservers) {
    globalThis.__amasoTerminalObservers = new Map();
  }
  return globalThis.__amasoTerminalObservers;
}

function resolveSessionId(projectId: string, sessionId?: string): string {
  return sessionId ?? projectId;
}

function ensureIdleObserver(projectId: string, sessionId?: string): void {
  const sid = resolveSessionId(projectId, sessionId);
  const map = observers();
  if (map.has(sid)) return;
  // No-op when the session doesn't exist yet — both backends'
  // subscribe() return a no-op cleanup in that case, and caching it
  // here would block a real subscription once the session is created.
  const backend = useRemote() ? remote : local;
  if (!backend.getSession(projectId, sid)) return;
  const unsub = backend.subscribe(
    projectId,
    () => noteActivity(projectId, sid),
    () => {
      cancelIdle(projectId, sid);
      map.delete(sid);
      unsub();
    },
    sid,
  );
  map.set(sid, unsub);
}

/**
 * Public-facing session shape — the union of fields callers actually
 * read. Both backends produce structurally compatible objects: the
 * local Session has these as a subset, the remote ClientSession is
 * projected to this exact shape.
 */
export interface SessionView {
  projectId: string;
  sessionId: string;
  scrollback: string;
  startedAt: number;
  cols: number;
  rows: number;
  proc: { pid?: number };
}

function useRemote(): boolean {
  if (!getPtyServiceUrl()) return false;
  // Sticky boot-time fallback: if init() couldn't reach the pty-service,
  // route every operation through the local backend until the next
  // dashboard restart. Without this, the operator sees terminal commands
  // hang or 500 instead of the in-process PTYs they had before flipping
  // the toggle.
  if (remote.fellBackToLocal()) return false;
  return true;
}

export function getSession(
  projectId: string,
  sessionId?: string,
): SessionView | null {
  if (useRemote()) return remote.getSession(projectId, sessionId);
  // Local Session has every SessionView field plus internals; structural
  // typing means we can hand it back as the narrower view.
  return local.getSession(projectId, sessionId);
}

export function getStatus(
  projectId: string,
  sessionId?: string,
): TerminalStatus {
  if (useRemote()) {
    // RemoteTerminalStatus and local TerminalStatus share the same
    // field set; the cast avoids importing the local type into the
    // remote module.
    return remote.getStatus(projectId, sessionId) as TerminalStatus;
  }
  return local.getStatus(projectId, sessionId);
}

export function start(
  projectId: string,
  cols?: number,
  rows?: number,
  sessionId?: string,
): SessionView {
  const sid = resolveSessionId(projectId, sessionId);
  const view = useRemote()
    ? remote.start(projectId, cols, rows, sid)
    : local.start(projectId, cols, rows, sid);
  ensureIdleObserver(projectId, sid);
  return view;
}

export function write(
  projectId: string,
  data: string,
  notifyUserId: number | null = null,
  sessionId?: string,
): boolean {
  const sid = resolveSessionId(projectId, sessionId);
  // Wrapper-level idle detection: arm the timer here so both backends
  // produce identical "Claude is klaar" pushes. The local backend's
  // own copy of this logic was removed in phase 4 — passing null
  // through prevents any future re-introduction from double-firing.
  ensureIdleObserver(projectId, sid);
  if (data.includes("\r") || data.includes("\n")) {
    armIdle(projectId, notifyUserId, sid);
  }
  if (useRemote()) return remote.write(projectId, data, null, sid);
  return local.write(projectId, data, null, sid);
}

export function resize(
  projectId: string,
  cols: number,
  rows: number,
  sessionId?: string,
): boolean {
  if (useRemote()) return remote.resize(projectId, cols, rows, sessionId);
  return local.resize(projectId, cols, rows, sessionId);
}

export function stop(projectId: string, sessionId?: string): boolean {
  if (useRemote()) return remote.stop(projectId, sessionId);
  return local.stop(projectId, sessionId);
}

export function subscribe(
  projectId: string,
  onData: (chunk: string) => void,
  onExit: (payload: { exitCode: number; signal: number | undefined }) => void,
  sessionId?: string,
): () => void {
  if (useRemote()) return remote.subscribe(projectId, onData, onExit, sessionId);
  return local.subscribe(projectId, onData, onExit, sessionId);
}

/** Kill every live session across both backends. Used when the active
 *  Claude account changes — existing sessions hold stale credentials
 *  and must be replaced. Awaits remote DELETEs so new spawns don't
 *  race stale sessions on the PTY service. */
export async function stopAll(): Promise<number> {
  let killed = 0;
  // Local sessions (sync — in-process PTYs die immediately)
  const localRegistry = globalThis.__amasoTerminals;
  if (localRegistry) {
    for (const [sid, s] of Array.from(localRegistry.entries())) {
      const session = s as { projectId: string; sessionId?: string };
      local.stop(session.projectId, session.sessionId ?? sid);
      killed++;
    }
  }
  // Remote sessions — await DELETEs + sweep orphans
  if (getPtyServiceUrl()) {
    killed += await remote.stopAllAsync();
  }
  // Clear idle observers
  const map = observers();
  for (const unsub of map.values()) unsub();
  map.clear();
  return killed;
}

/** Every live session for the given project across the active backend.
 *  Stage 1 returns at most one entry; Stage 2 enables real multi-session
 *  lists. Callers should treat the result as read-only. */
export function listSessionsForProject(projectId: string): SessionView[] {
  if (useRemote()) return remote.listSessionsForProject(projectId);
  return local
    .listSessionsForProject(projectId)
    .map((s) => ({
      projectId: s.projectId,
      sessionId: s.sessionId,
      scrollback: s.scrollback,
      startedAt: s.startedAt,
      cols: s.cols,
      rows: s.rows,
      proc: { pid: s.proc.pid ?? undefined },
    }));
}

/**
 * One-shot startup hook. Wires the remote client's session-discovery
 * pass when the toggle is on; no-op when off. Safe to call multiple
 * times — the remote client guards against re-entry.
 *
 * Post-discovery: replays any dispatch log entries that were still
 * pending when the previous dashboard process exited. Without this,
 * a dispatch in flight when the watchdog cycles us never produces an
 * auto-report — the in-memory awaitingResponse state was wiped, so
 * even when the persistent pty-service session eventually goes quiet
 * no fireIdle runs, no broadcast goes out, and the user gets silence.
 */
export async function init(): Promise<void> {
  if (!useRemote()) return;
  await remote.init();
  await recoverPendingDispatches();
}

async function recoverPendingDispatches(): Promise<void> {
  // Lazy import: spar-dispatch -> terminal-backend is already a cycle
  // (dispatchToProject calls writeTerminal); the dynamic import keeps
  // the call site here from re-entering during module init.
  const { pendingDispatches } = await import("./spar-dispatch");
  let recovered = 0;
  let skipped = 0;
  try {
    for (const { userId, entry } of pendingDispatches()) {
      // Stage 1: dispatch entries don't carry sessionId yet, so use
      // the project-default session. Stage 2's spar-dispatch will
      // record sessionId on each entry and we'll resolve through it
      // here.
      const sid = entry.sessionId ?? entry.projectId;
      const session = getSession(entry.projectId, sid);
      if (!session) {
        // Session is gone (pty-service didn't have it on adopt, or it
        // exited). Nothing to re-arm — let the polling fallback in
        // SparProvider catch it via /api/spar/dispatches when the
        // entry eventually gets markDispatchCompleted'd by some other
        // path, or surface as "no terminal" in the UI.
        skipped++;
        continue;
      }
      ensureIdleObserver(entry.projectId, sid);
      armIdleWithImmediateTimer(entry.projectId, userId, sid);
      recovered++;
    }
    if (recovered > 0 || skipped > 0) {
      console.log(
        `[terminal-backend] post-restart dispatch recovery: ${recovered} re-armed, ${skipped} skipped`,
      );
    }
  } catch (err) {
    console.warn("[terminal-backend] dispatch recovery failed:", err);
  }
}
