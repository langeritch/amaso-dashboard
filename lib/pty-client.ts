// HTTP + WebSocket client for the external amaso-pty-service.
//
// When the dashboard is configured with a PTY_SERVICE_URL (or
// `ptyServiceUrl` in amaso.config.json), `lib/terminal-backend.ts` routes
// every terminal operation through this module instead of `lib/terminal.ts`.
// The point: PTYs survive dashboard restarts because they live in the
// external service's process, not ours.
//
// Key design choice — **synchronous public API backed by local mirrors.**
// The existing dashboard callers (spar-dispatch, autopilot, worker-status,
// terminal-ws, …) call `getSession(projectId).scrollback` synchronously
// and pass the result around. Going async would mean refactoring six
// call sites. Instead we maintain a per-session mirror in this process
// (scrollback ring + startedAt + cols/rows + EventEmitter) that's fed by
// a long-lived WebSocket to the service. `start()` returns the mirror
// immediately; the HTTP POST /sessions runs in the background, with
// writes queued in the ManagedWS until the WS is up.
//
// Idle detection (the "Claude is klaar" push + the spar auto-report
// broadcast) lives in lib/terminal-backend.ts now and observes the
// active backend's data stream via subscribe(). Both the local and
// remote paths produce identical dispatch-completed signals.

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { spawnEnvOverrides } from "./claude-accounts";
import { getProject, getPtyServiceUrl } from "./config";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_SCROLLBACK_BYTES = Number(
  process.env.AMASO_SCROLLBACK_BYTES ?? 1_000_000,
);
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// HTTP request timeout. The PTY service is local — anything taking longer
// than 5s is a bug, not a slow network. Surfacing failures fast lets the
// callers fall back / log instead of stalling the request handler.
const HTTP_TIMEOUT_MS = 5_000;

export interface SessionView {
  projectId: string;
  /** Stable identifier used by the pty-service. In Stage 1 always
   *  equals `projectId` — Stage 2 introduces real per-spawn ids. */
  sessionId: string;
  scrollback: string;
  startedAt: number;
  cols: number;
  rows: number;
  /** Mirrors node-pty's IPty shape so existing callers can read
   *  `session.proc.pid` without changes. */
  proc: { pid?: number };
}

export interface RemoteTerminalStatus {
  projectId: string;
  sessionId: string;
  running: boolean;
  pid: number | null;
  cwd: string | null;
  startedAt: number | null;
  cols: number;
  rows: number;
  scrollback: string;
}

interface SpawnResponse {
  id: string;
  pid: number;
  createdAt: number;
  ghost?: boolean;
}

interface ListResponse {
  id: string;
  pid: number;
  createdAt: number;
  lastActivity: number;
  ghost: boolean;
}

interface DetailResponse {
  id: string;
  pid: number;
  createdAt: number;
  lastActivity: number;
  ghost: boolean;
  scrollback: string;
}

interface ClientSession {
  /** Stable session identifier — what the pty-service knows it as,
   *  what the WS path uses, and what the local registry keys on. */
  sessionId: string;
  /** Project this session belongs to. In Stage 1 sessionId === projectId
   *  for every session; Stage 2 lets a single project host N sessions
   *  with distinct sessionIds. */
  projectId: string;
  pid: number | null;
  startedAt: number;
  cols: number;
  rows: number;
  scrollback: string;
  emitter: EventEmitter;
  ws: ManagedWS | null;
  /** Writes received before the WS connects — flushed on first `open`. */
  pendingWrites: string[];
  /** True once the session has terminated (POST failed, exit received,
   *  explicit stop). Subscribers seeing this should drop their handles. */
  exited: boolean;
}

/** Resolve the registry key. Stage-1 callers pass only projectId, so
 *  sessionId falls back to projectId — preserving the
 *  one-session-per-project assumption end-to-end. */
function resolveSessionId(projectId: string, sessionId?: string): string {
  return sessionId ?? projectId;
}

interface RegistryGlobal {
  sessions: Map<string, ClientSession>;
  initState: "idle" | "running" | "done" | "failed";
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoPtyClient: RegistryGlobal | undefined;
}

function registry(): RegistryGlobal {
  if (!globalThis.__amasoPtyClient) {
    globalThis.__amasoPtyClient = {
      sessions: new Map(),
      initState: "idle",
    };
  }
  return globalThis.__amasoPtyClient;
}

function sessions(): Map<string, ClientSession> {
  return registry().sessions;
}

function httpBase(): string {
  return getPtyServiceUrl().replace(/\/+$/, "");
}

function wsBase(): string {
  const http = httpBase();
  if (http.startsWith("https://")) return "wss://" + http.slice(8);
  if (http.startsWith("http://")) return "ws://" + http.slice(7);
  return http;
}

/**
 * Auto-reconnecting WebSocket wrapper. Buffers outgoing frames while
 * disconnected and drains them on (re)connect. Stops trying when the
 * remote closes with 1000 (clean exit — session is gone) or when
 * `close()` is called explicitly.
 */
class ManagedWS extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending: string[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly url: string) {
    super();
    this.connect();
  }

  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.pending.push(data);
    }
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      // URL malformed / immediate failure — schedule a retry rather than
      // throw, so a transient config blip doesn't crash the dashboard.
      console.warn("[pty-client] ws connect threw:", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      const queue = this.pending;
      this.pending = [];
      for (const w of queue) ws.send(w);
      this.emit("open");
    });
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const s = isBinary
        ? Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8")
        : data.toString();
      this.emit("data", s);
    });
    ws.on("close", (code: number) => {
      this.ws = null;
      // 1000 = normal close (PTY exited), 1008 = policy violation (404
      // / 410 from upgrade — session gone). In both cases reconnect is
      // pointless: the session won't come back at the same id.
      if (code === 1000 || code === 1008) {
        this.stopped = true;
        this.emit("exit", { code });
        return;
      }
      if (!this.stopped) this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      // 'error' fires before 'close' on connection failure. We don't
      // act on it here — the close handler does the reconnect dance —
      // but we do swallow it from the default-handler "Unhandled error"
      // crash path.
      void err;
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(httpBase() + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`pty-service ${res.status}: ${body || res.statusText}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVoid(path: string, init: RequestInit = {}): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(httpBase() + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => "");
      throw new Error(`pty-service ${res.status}: ${body || res.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function attachWs(session: ClientSession): void {
  const url = `${wsBase()}/sessions/${encodeURIComponent(session.sessionId)}/stream?scrollback=0`;
  const ws = new ManagedWS(url);
  ws.on("data", (chunk: string) => {
    session.scrollback += chunk;
    if (session.scrollback.length > MAX_SCROLLBACK_BYTES) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK_BYTES);
    }
    session.emitter.emit("data", chunk);
  });
  ws.on("exit", () => {
    if (session.exited) return;
    session.exited = true;
    session.emitter.emit("exit", { exitCode: 0, signal: undefined });
    sessions().delete(session.sessionId);
  });
  // Drain session-level pending writes onto the ws (which has its own
  // queue, but only those it received via send() — we kept ours separate
  // so writes that arrived before the ws existed don't get lost).
  ws.on("open", () => {
    const queue = session.pendingWrites;
    session.pendingWrites = [];
    for (const w of queue) ws.send(w);
  });
  session.ws = ws;
}

function createMirror(opts: {
  projectId: string;
  sessionId: string;
  pid: number | null;
  startedAt: number;
  cols: number;
  rows: number;
  initialScrollback?: string;
}): ClientSession {
  const session: ClientSession = {
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    pid: opts.pid,
    startedAt: opts.startedAt,
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.initialScrollback ?? "",
    emitter: new EventEmitter(),
    ws: null,
    pendingWrites: [],
    exited: false,
  };
  // EventEmitter defaults to a 10-listener warning. The dashboard fans
  // out per-tab subscriptions plus crons (autopilot, heartbeat, worker-
  // status), easily cresting 10 — match terminal.ts and disable the cap.
  session.emitter.setMaxListeners(0);
  sessions().set(opts.sessionId, session);
  return session;
}

/**
 * Public helper — exposes a SessionView shape so terminal-backend's
 * routing layer can hand callers an object structurally identical to
 * what `lib/terminal.ts`'s `getSession` returns.
 */
function toView(s: ClientSession): SessionView {
  return {
    projectId: s.projectId,
    sessionId: s.sessionId,
    scrollback: s.scrollback,
    startedAt: s.startedAt,
    cols: s.cols,
    rows: s.rows,
    proc: { pid: s.pid ?? undefined },
  };
}

export function getSession(
  projectId: string,
  sessionId?: string,
): SessionView | null {
  const s = sessions().get(resolveSessionId(projectId, sessionId));
  if (!s || s.exited) return null;
  return toView(s);
}

export function getStatus(
  projectId: string,
  sessionId?: string,
): RemoteTerminalStatus {
  const sid = resolveSessionId(projectId, sessionId);
  const s = sessions().get(sid);
  const project = getProject(projectId);
  if (!s || s.exited) {
    return {
      projectId,
      sessionId: sid,
      running: false,
      pid: null,
      cwd: project?.path ?? null,
      startedAt: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: "",
    };
  }
  return {
    projectId: s.projectId,
    sessionId: s.sessionId,
    running: true,
    pid: s.pid,
    cwd: project?.path ?? null,
    startedAt: s.startedAt,
    cols: s.cols,
    rows: s.rows,
    scrollback: s.scrollback,
  };
}

export function start(
  projectId: string,
  cols: number = DEFAULT_COLS,
  rows: number = DEFAULT_ROWS,
  sessionId?: string,
): SessionView {
  const sid = resolveSessionId(projectId, sessionId);
  const existing = sessions().get(sid);
  if (existing && !existing.exited) return toView(existing);

  const project = getProject(projectId);
  if (!project) throw new Error("project_not_found");

  // Optimistic mirror so callers see the session immediately. PID is
  // null until the POST /sessions response lands; spar-tools' first-call
  // response shows pid=null briefly, which is acceptable.
  const session = createMirror({
    projectId,
    sessionId: sid,
    pid: null,
    startedAt: Date.now(),
    cols,
    rows,
  });

  // Pass through the active Claude account's env overrides (today:
  // CLAUDE_CONFIG_DIR). The pty-service merges these into the spawn env
  // so a fresh `claude.exe` reads the right account's credentials. Empty
  // object when no account is configured, in which case the pty-service
  // falls back to its own default scrubbed env.
  const envOverrides = spawnEnvOverrides();

  void (async () => {
    try {
      const resp = await fetchJson<SpawnResponse>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          id: sid,
          cwd: project.path,
          cols,
          rows,
          env: envOverrides,
        }),
      });
      // The service may return ghost: true if the id mapped to a re-
      // adopted entry from its own manifest — that path replaces the
      // ghost with a fresh PID server-side, so we just take the new
      // pid/createdAt and proceed.
      session.pid = resp.pid;
      session.startedAt = resp.createdAt;
      attachWs(session);
    } catch (err) {
      console.error("[pty-client] spawn failed for", sid, err);
      if (!session.exited) {
        session.exited = true;
        session.emitter.emit("exit", { exitCode: -1, signal: undefined });
        sessions().delete(sid);
      }
    }
  })();

  return toView(session);
}

export function write(
  projectId: string,
  data: string,
  // notifyUserId is accepted for signature parity with lib/terminal.ts.
  // Idle detection runs at the wrapper layer (lib/terminal-backend.ts),
  // so the wrapper passes null through and arms the timer itself.
  _notifyUserId: number | null = null,
  sessionId?: string,
): boolean {
  const s = sessions().get(resolveSessionId(projectId, sessionId));
  if (!s || s.exited) return false;
  if (s.ws) {
    s.ws.send(data);
  } else {
    // WS not attached yet (POST /sessions still in flight). Buffer
    // here; attachWs() drains on first 'open'.
    s.pendingWrites.push(data);
  }
  return true;
}

export function resize(
  projectId: string,
  cols: number,
  rows: number,
  sessionId?: string,
): boolean {
  const sid = resolveSessionId(projectId, sessionId);
  const s = sessions().get(sid);
  if (!s || s.exited) return false;
  s.cols = cols;
  s.rows = rows;
  void fetchVoid(`/sessions/${encodeURIComponent(sid)}/resize`, {
    method: "POST",
    body: JSON.stringify({ cols, rows }),
  }).catch((err) => {
    console.warn("[pty-client] resize failed for", sid, err);
  });
  return true;
}

export function stop(projectId: string, sessionId?: string): boolean {
  const sid = resolveSessionId(projectId, sessionId);
  const s = sessions().get(sid);
  if (!s) return false;
  if (!s.exited) {
    s.exited = true;
    s.emitter.emit("exit", { exitCode: 0, signal: undefined });
  }
  if (s.ws) {
    s.ws.close();
    s.ws = null;
  }
  sessions().delete(sid);
  void fetchVoid(`/sessions/${encodeURIComponent(sid)}`, {
    method: "DELETE",
  }).catch((err) => {
    console.warn("[pty-client] stop failed for", sid, err);
  });
  return true;
}

export function subscribe(
  projectId: string,
  onData: (chunk: string) => void,
  onExit: (payload: { exitCode: number; signal: number | undefined }) => void,
  sessionId?: string,
): () => void {
  const s = sessions().get(resolveSessionId(projectId, sessionId));
  if (!s || s.exited) return () => {};
  s.emitter.on("data", onData);
  s.emitter.on("exit", onExit);
  return () => {
    s.emitter.off("data", onData);
    s.emitter.off("exit", onExit);
  };
}

/** Every live session view for the given project. Stage 1 returns at
 *  most one entry; Stage 2 enables real multi-session lists. */
export function listSessionsForProject(projectId: string): SessionView[] {
  const out: SessionView[] = [];
  for (const s of sessions().values()) {
    if (s.exited) continue;
    if (s.projectId === projectId) out.push(toView(s));
  }
  return out;
}

/**
 * One-shot startup discovery. Call once after the dashboard boots to
 * adopt sessions that already exist on the PTY service. Idempotent —
 * a second call after success is a no-op. Failures are logged and
 * non-fatal; subsequent operations still work, they just won't pre-
 * populate getSession().
 */
export async function init(): Promise<void> {
  const reg = registry();
  if (!httpBase()) return;
  if (reg.initState === "running" || reg.initState === "done") return;
  reg.initState = "running";
  try {
    const list = await fetchJson<ListResponse[]>("/sessions");
    let adopted = 0;
    let skipped = 0;
    for (const entry of list) {
      if (entry.ghost) {
        // Ghosts are dead-stdio re-adoptions on the service side. Skip
        // them — the next user-driven start() will replace the ghost
        // with a fresh spawn under the same id.
        skipped++;
        continue;
      }
      if (sessions().has(entry.id)) continue;
      const detail = await fetchJson<DetailResponse>(
        `/sessions/${encodeURIComponent(entry.id)}?tail=${MAX_SCROLLBACK_BYTES}`,
      ).catch(() => null);
      // Stage 1 invariant: the pty-service `id` for every session ever
      // spawned by the dashboard is the projectId. Adopt that as both
      // sessionId and projectId. Stage 2 will extend the pty-service
      // manifest to carry an explicit projectId field so adoption can
      // recover compound `<projectId>:<sessionUuid>` ids correctly.
      const session = createMirror({
        sessionId: entry.id,
        projectId: entry.id,
        pid: entry.pid,
        startedAt: entry.createdAt,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        initialScrollback: detail?.scrollback ?? "",
      });
      attachWs(session);
      adopted++;
    }
    reg.initState = "done";
    console.log(
      `[pty-client] adopted ${adopted} session(s) from ${httpBase()}` +
        (skipped > 0 ? ` (skipped ${skipped} ghost(s))` : ""),
    );
  } catch (err) {
    reg.initState = "failed";
    console.warn(
      `[pty-client] init failed against ${httpBase()} — falling back to in-process PTYs for this dashboard boot. Restart the dashboard once the pty-service is reachable to opt back in.`,
      err,
    );
  }
}

/** Kill every known session (awaiting DELETEs), then sweep the PTY service
 *  for orphans the dashboard mirror didn't know about. Returns total killed.
 *  Used on account switch so new spawns don't race stale sessions. */
export async function stopAllAsync(): Promise<number> {
  let killed = 0;
  const knownIds = new Set<string>();
  for (const [sid, s] of Array.from(sessions().entries())) {
    knownIds.add(sid);
    if (!s.exited) {
      s.exited = true;
      s.emitter.emit("exit", { exitCode: 0, signal: undefined });
    }
    if (s.ws) {
      s.ws.close();
      s.ws = null;
    }
    sessions().delete(sid);
    try {
      await fetchVoid(`/sessions/${encodeURIComponent(sid)}`, {
        method: "DELETE",
      });
    } catch (err) {
      console.warn("[pty-client] stopAllAsync: delete failed for", sid, err);
    }
    killed++;
  }
  // Sweep: catch orphaned sessions the dashboard mirror didn't track
  try {
    if (!httpBase()) return killed;
    const list = await fetchJson<ListResponse[]>("/sessions");
    for (const entry of list) {
      if (knownIds.has(entry.id)) continue;
      try {
        await fetchVoid(`/sessions/${encodeURIComponent(entry.id)}`, {
          method: "DELETE",
        });
        killed++;
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* PTY service unreachable — nothing to sweep */
  }
  return killed;
}

/** True when the toggle is on. Cheap — re-reads env / config each call. */
export function isEnabled(): boolean {
  return Boolean(httpBase());
}

/**
 * True when init() ran and could not reach the pty-service. The wrapper
 * uses this to make the boot-time decision sticky: once we fall back to
 * local for this boot, we stay local until the dashboard is restarted.
 * That keeps a single project id from accumulating both a local session
 * (started during the outage) and a remote session (started later) — the
 * "split brain" the synchronous mirror design can't resolve.
 *
 * Returns false until init() finishes; the wrapper is optimistic during
 * the boot gap. In practice the first terminal operation lands seconds
 * after init, so the race is theoretical.
 */
export function fellBackToLocal(): boolean {
  return registry().initState === "failed";
}
