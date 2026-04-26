/**
 * Companion WebSocket channel.
 *
 * One socket per signed-in user; the macOS menu-bar companion (see
 * `electron/`) opens this connection after login and holds it for the
 * lifetime of the session. The dashboard talks to the companion over
 * this socket — telling it to duck audio, fetch a file, run a shell
 * command — and the companion streams state events back.
 *
 * Kept intentionally separate from the project/chat WebSocket in
 * `lib/ws.ts` because:
 *   - Different message schema, different lifecycle (one companion
 *     per user, many browser tabs per user).
 *   - Command commitment: we want commands addressed at *this user's*
 *     companion, not broadcast to every socket the user has open.
 *   - Security boundary: companion commands can touch the user's
 *     local machine, so we don't mix them with the project-updates
 *     stream that clients routinely mirror to other tabs.
 *
 * Protocol:
 *   server → client
 *     { type: "hello", user: {...} }
 *     { type: "ping", ts }
 *     { type: "command", id, command: { type: string, ... } }
 *
 *   client → server
 *     { type: "pong", ts }
 *     { type: "ack", id, ok, error?, result? }
 *     { type: "event", event: string, data? }
 *
 * Auth: same `amaso_session` cookie the browser uses. The companion
 * persists it to safeStorage at login time and includes it on the
 * upgrade handshake.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { sessionIdFromHeader, userFromSession } from "./auth-core";
import type { User } from "./db";
import {
  enqueueCommand,
  flushQueueForUser,
  type QueuedCommand,
} from "./companion-queue";
import { recordActivity } from "./presence";

export type CompanionCommand =
  | { type: "audio.duck"; level?: number }
  | { type: "audio.restore" }
  | { type: "shell.exec"; cmd: string; cwd?: string }
  | { type: "fs.read"; path: string };

export interface CompanionAck {
  id: string;
  ok: boolean;
  error?: string;
  result?: unknown;
}

export interface CompanionEvent {
  event: string;
  data?: unknown;
}

type ServerMessage =
  | { type: "hello"; user: { id: number; name: string; role: User["role"] } }
  | { type: "ping"; ts: number }
  | { type: "command"; id: string; command: CompanionCommand };

type ClientMessage =
  | { type: "pong"; ts: number }
  | ({ type: "ack" } & CompanionAck)
  | ({ type: "event" } & CompanionEvent);

interface PendingCommand {
  resolve: (ack: CompanionAck) => void;
  timer: NodeJS.Timeout;
  /** Snapshot of what was sent — used by the ack handler to write a
   *  rich activity log entry without forcing callers to keep state. */
  command: CompanionCommand;
  /** Wall-clock dispatch time, used for ms-elapsed in the log row.
   *  For replayed commands this is the replay time, not the original
   *  enqueue time — `enqueuedAt` carries the original. */
  dispatchedAt: number;
  /** True if this command came out of the offline queue. Drives a
   *  "(replayed)" annotation in the activity log. */
  replay: boolean;
  /** Original enqueue time for replayed commands; null otherwise. */
  enqueuedAt: number | null;
}

interface ClientState {
  user: User;
  ws: WebSocket;
  /** Unacked commands we sent — used to timeout + surface failures. */
  pending: Map<string, PendingCommand>;
  lastPong: number;
  listeners: Set<(evt: CompanionEvent) => void>;
}

// Multiple sockets per user are allowed (user could reinstall, open two
// Macs, etc.). Commands fan out to all of them; listeners aggregate.
const byUser = new Map<number, Set<ClientState>>();

const PING_INTERVAL_MS = 20_000;
const PONG_GRACE_MS = 45_000;
const COMMAND_TIMEOUT_MS = 10_000;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Cap the size of any value we stuff into a user_activity.detail
 *  JSON column. shell.exec results can carry up to 1 MB of stdout —
 *  storing that on every command would balloon the table. Truncated
 *  fields are still useful for "what happened" forensics; the full
 *  payload was already returned to the original caller. */
const ACTIVITY_DETAIL_MAX_CHARS = 4_000;

function truncateForActivity(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    return "<unserialisable>";
  }
  if (s.length <= ACTIVITY_DETAIL_MAX_CHARS) return value;
  // Re-parse the truncated form so the consumer side still gets a
  // string rather than a partial object. Activity-feed UIs show this
  // verbatim; partial JSON would render as "[invalid]".
  return s.slice(0, ACTIVITY_DETAIL_MAX_CHARS) + "…";
}

function logCommandDispatch(
  userId: number,
  commandId: string,
  command: CompanionCommand,
  opts: { queued: boolean; replay?: boolean; enqueuedAt?: number | null },
): void {
  try {
    recordActivity({
      userId,
      presenceId: null,
      kind: "action",
      label: `companion:${command.type}:dispatch`,
      detail: {
        commandId,
        command: truncateForActivity(command),
        queued: opts.queued,
        replay: !!opts.replay,
        enqueuedAt: opts.enqueuedAt ?? null,
      },
    });
  } catch (err) {
    console.warn("[companion-ws] dispatch log failed:", err);
  }
}

function logCommandQueueReplay(userId: number, item: QueuedCommand): void {
  try {
    recordActivity({
      userId,
      presenceId: null,
      kind: "action",
      label: `companion:${item.command.type}:replay`,
      detail: {
        commandId: item.commandId,
        command: truncateForActivity(item.command),
        enqueuedAt: item.enqueuedAt,
        replayedAt: Date.now(),
      },
    });
  } catch (err) {
    console.warn("[companion-ws] replay log failed:", err);
  }
}

function logCommandAck(
  userId: number,
  pending: PendingCommand,
  ack: CompanionAck,
): void {
  try {
    recordActivity({
      userId,
      presenceId: null,
      kind: "action",
      label: `companion:${pending.command.type}:${ack.ok ? "ok" : "fail"}`,
      detail: {
        commandId: ack.id,
        command: truncateForActivity(pending.command),
        ok: ack.ok,
        error: ack.error ?? null,
        result: truncateForActivity(ack.result),
        ms: Date.now() - pending.dispatchedAt,
        replay: pending.replay,
        enqueuedAt: pending.enqueuedAt,
      },
    });
  } catch (err) {
    console.warn("[companion-ws] ack log failed:", err);
  }
}

/**
 * Register an in-flight command on a specific client and send it.
 * Centralises the timeout + bookkeeping that both fresh dispatches
 * (`sendCommand`) and queue replays (`connection` handler) need.
 *
 * Returns a Promise resolving to the ack (or a synthetic timeout
 * ack). Replay paths discard the promise — the activity log is the
 * durable record there.
 */
function registerCommandFlight(
  state: ClientState,
  id: string,
  command: CompanionCommand,
  opts: { replay?: boolean; enqueuedAt?: number | null } = {},
): Promise<CompanionAck> {
  return new Promise<CompanionAck>((resolve) => {
    const timer = setTimeout(() => {
      // Pending may already be gone if the ack arrived just as the
      // timer fired. Guard the delete + resolve so we don't double-
      // resolve.
      if (!state.pending.has(id)) return;
      state.pending.delete(id);
      const ack: CompanionAck = { id, ok: false, error: "timeout" };
      // Materialise the timeout in the activity log so the dashboard
      // doesn't silently lose a command — same shape as a real ack.
      logCommandAck(
        state.user.id,
        {
          resolve,
          timer,
          command,
          dispatchedAt: Date.now() - COMMAND_TIMEOUT_MS,
          replay: !!opts.replay,
          enqueuedAt: opts.enqueuedAt ?? null,
        },
        ack,
      );
      resolve(ack);
    }, COMMAND_TIMEOUT_MS);
    state.pending.set(id, {
      resolve,
      timer,
      command,
      dispatchedAt: Date.now(),
      replay: !!opts.replay,
      enqueuedAt: opts.enqueuedAt ?? null,
    });
    send(state.ws, { type: "command", id, command });
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoCompanionWs: ReturnType<typeof buildCompanionWs> | undefined;
}

function buildCompanionWs() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req: IncomingMessage & { amasoUser?: User }) => {
    const user = req.amasoUser!;
    const state: ClientState = {
      user,
      ws,
      pending: new Map(),
      lastPong: Date.now(),
      listeners: new Set(),
    };
    let clientsForUser = byUser.get(user.id);
    if (!clientsForUser) {
      clientsForUser = new Set();
      byUser.set(user.id, clientsForUser);
    }
    clientsForUser.add(state);
    console.log(`[companion-ws] connected user=${user.id} (${user.name})`);

    send(ws, {
      type: "hello",
      user: { id: user.id, name: user.name, role: user.role },
    });

    // Flush any commands the dashboard tried to dispatch while this
    // user had no companion online. Each row is replayed with its
    // original wire id so any caller still holding a reference to the
    // ack flow gets a clean reply (though in practice callers have
    // already moved on and treated `[]` as the result; the activity
    // log is the durable record). Run AFTER `hello` so the companion
    // has a chance to wire its own state (`amaso:status` event, etc.)
    // before commands start arriving.
    let queued: QueuedCommand[] = [];
    try {
      queued = flushQueueForUser(user.id);
    } catch (err) {
      console.warn("[companion-ws] queue flush failed:", err);
    }
    for (const item of queued) {
      logCommandQueueReplay(user.id, item);
      // Reuse the registerCommandFlight helper so the ack timeout +
      // pending bookkeeping match a fresh dispatch. We don't expose
      // the resolved promise to anyone — replays are fire-and-forget
      // from the dashboard's side; the ack hits the activity log
      // either way.
      registerCommandFlight(state, item.commandId, item.command, {
        replay: true,
        enqueuedAt: item.enqueuedAt,
      });
    }

    const pingTimer = setInterval(() => {
      // Dead-connection detection: if the last pong is older than our
      // grace window, stop pinging and close — the ws library's native
      // ping/pong doesn't surface timeouts reliably across all proxies.
      if (Date.now() - state.lastPong > PONG_GRACE_MS) {
        console.warn(`[companion-ws] user=${user.id} pong timeout, closing`);
        try {
          ws.close(4000, "pong timeout");
        } catch {
          /* ignore */
        }
        return;
      }
      send(ws, { type: "ping", ts: Date.now() });
    }, PING_INTERVAL_MS);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "pong") {
        state.lastPong = Date.now();
        return;
      }
      if (msg.type === "ack") {
        const pending = state.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          state.pending.delete(msg.id);
          const ack: CompanionAck = {
            id: msg.id,
            ok: msg.ok,
            error: msg.error,
            result: msg.result,
          };
          logCommandAck(state.user.id, pending, ack);
          pending.resolve(ack);
        }
        return;
      }
      if (msg.type === "event") {
        for (const listener of state.listeners) {
          try {
            listener({ event: msg.event, data: msg.data });
          } catch (err) {
            console.error("[companion-ws] listener threw", err);
          }
        }
      }
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      for (const pending of state.pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ id: "", ok: false, error: "socket closed" });
      }
      state.pending.clear();
      const set = byUser.get(user.id);
      if (set) {
        set.delete(state);
        if (set.size === 0) byUser.delete(user.id);
      }
      console.log(`[companion-ws] disconnected user=${user.id}`);
    });
  });

  return {
    wss,
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      // CSWSH guard. Companion commands can run shell on the user's
      // local machine — letting attacker.com open this socket via a
      // logged-in user's browser would be catastrophic. SameSite=lax
      // on the cookie helps, but this header check is the explicit
      // belt-and-braces, mirroring browser-ws / terminal-ws.
      const origin = req.headers.origin;
      const host = req.headers.host;
      const xfHost = req.headers["x-forwarded-host"];
      if (!originMatchesHost(origin, host, xfHost)) {
        console.warn(
          `[companion-ws] 403 origin mismatch — origin=${origin} host=${host} xf-host=${xfHost ?? "-"}`,
        );
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const sid = sessionIdFromHeader(req.headers.cookie);
      const user = sid ? userFromSession(sid) : null;
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      (req as IncomingMessage & { amasoUser?: User }).amasoUser = user;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    },

    /**
     * Dispatch a command to every companion instance the user has
     * connected. Returns the list of acks collected across sockets.
     * Resolves individual sockets with `ok:false, error:"timeout"` if
     * they don't respond within COMMAND_TIMEOUT_MS.
     *
     * If the user has zero companions online right now, the command is
     * persisted in `companion_command_queue` and replayed the next
     * time a companion socket comes up. The returned ack list will
     * contain a single synthetic `{ok:false, error:"queued"}` so
     * callers can distinguish "delivered to nobody" from "was
     * delivered but the companion failed". The activity log records
     * the dispatch either way.
     */
    async sendCommand(userId: number, command: CompanionCommand): Promise<CompanionAck[]> {
      const clients = byUser.get(userId);
      const id = crypto.randomBytes(8).toString("base64url");

      if (!clients || clients.size === 0) {
        try {
          enqueueCommand({ userId, commandId: id, command });
        } catch (err) {
          console.warn("[companion-ws] enqueue failed:", err);
        }
        logCommandDispatch(userId, id, command, { queued: true });
        return [{ id, ok: false, error: "queued" }];
      }

      logCommandDispatch(userId, id, command, { queued: false });
      const promises: Promise<CompanionAck>[] = [];
      for (const state of clients) {
        promises.push(registerCommandFlight(state, id, command));
      }
      return Promise.all(promises);
    },

    /**
     * Subscribe to events from a specific user's companion sockets.
     * Returns an unsubscribe function. Useful for dashboard consumers
     * that want to watch VAD state or command completions.
     */
    subscribe(userId: number, listener: (evt: CompanionEvent) => void): () => void {
      const clients = byUser.get(userId);
      if (!clients) return () => {};
      for (const state of clients) state.listeners.add(listener);
      return () => {
        const current = byUser.get(userId);
        if (!current) return;
        for (const state of current) state.listeners.delete(listener);
      };
    },

    /** Quick poll for whether any companion socket is online for the user. */
    isConnected(userId: number): boolean {
      const clients = byUser.get(userId);
      return !!clients && clients.size > 0;
    },
  };
}

/**
 * Mirror of the helper in lib/browser-ws.ts and lib/ws.ts — kept
 * duplicated rather than shared so each WS module is self-contained
 * and the CSWSH guard at the top of every handleUpgrade is one
 * obvious block. See browser-ws.ts for the full rationale on why
 * X-Forwarded-Host is accepted (Cloudflare tunnel rewrites Host).
 */
function originMatchesHost(
  origin: string | undefined,
  host: string | undefined,
  xForwardedHost: string | string[] | undefined,
): boolean {
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const candidates = new Set<string>();
  if (host) candidates.add(host);
  if (xForwardedHost) {
    const xf = Array.isArray(xForwardedHost) ? xForwardedHost[0] : xForwardedHost;
    if (xf) candidates.add(xf);
  }
  const stripPort = (h: string): string => h.replace(/:\d+$/, "");
  for (const c of candidates) {
    if (c === originHost) return true;
    if (stripPort(c) === stripPort(originHost)) return true;
  }
  return false;
}

export function createCompanionWs() {
  if (!globalThis.__amasoCompanionWs) {
    globalThis.__amasoCompanionWs = buildCompanionWs();
  }
  return globalThis.__amasoCompanionWs;
}

/** Convenience — callable from API routes without touching the ws instance. */
export async function sendCompanionCommand(
  userId: number,
  command: CompanionCommand,
): Promise<CompanionAck[]> {
  return globalThis.__amasoCompanionWs?.sendCommand(userId, command) ?? [];
}

export function isCompanionConnected(userId: number): boolean {
  return globalThis.__amasoCompanionWs?.isConnected(userId) ?? false;
}
