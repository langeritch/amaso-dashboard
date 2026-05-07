/**
 * Extension bridge WebSocket.
 *
 * One socket per browser-extension instance the user has running. The
 * extension lives in the user's *real* Chrome session — same logins,
 * cookies, profile state — and exposes the Chrome DevTools Protocol
 * (via chrome.debugger) to the dashboard. The sparring partner drives
 * pages through this bridge instead of spawning a separate Playwright
 * Chrome.
 *
 * Why this is a separate WS module rather than reusing companion-ws:
 *   - Different protocol (browser_* tool calls + accessibility-tree
 *     responses, vs companion's audio/shell/fs commands).
 *   - Different lifetime: a user can have one Chrome with one driver
 *     extension; companion is a Mac menu-bar app. Don't entangle.
 *   - Origin allowlist: this socket accepts the extension's
 *     chrome-extension:// origin, which would be wrong for any other
 *     dashboard surface.
 *
 * Protocol:
 *   server → ext
 *     { type: "hello", user: {...} }
 *     { type: "ping",  ts }
 *     { type: "command", id, command: { tool: "browser_click", args: {...} } }
 *
 *   ext → server
 *     { type: "pong",  ts }
 *     { type: "ack",   id, ok, error?, result? }
 *     { type: "event", event: string, data? }
 *
 * Auth: the dashboard's `amaso_session` cookie. The extension's WS
 * connects to the dashboard host, browsers send host-bound cookies on
 * WebSocket handshakes, so the same `userFromSession` lookup we use on
 * every other WS works unchanged.
 *
 * CSWSH: the extension's Origin header is `chrome-extension://<id>`.
 * `AMASO_EXT_BRIDGE_ALLOWED_ORIGINS` (comma-separated) lists the
 * extension IDs we trust. If unset we fall back to allowing any
 * chrome-extension:// origin AND same-host origins, with a warning —
 * single-user dev mode. In multi-user prod set this var explicitly.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  sessionIdFromHeader,
  userFromSession,
  verifySigned,
} from "./auth-core";
import type { User } from "./db";

export interface ExtCommand {
  /** browser_navigate, browser_click, browser_snapshot, … — same names
   *  Playwright MCP exposes so the spar prompt doesn't need to change. */
  tool: string;
  args: Record<string, unknown>;
}

export interface ExtAck {
  id: string;
  ok: boolean;
  error?: string;
  result?: unknown;
}

export interface ExtEvent {
  event: string;
  data?: unknown;
}

type ServerMessage =
  | { type: "hello"; user: { id: number; name: string; role: User["role"] } }
  | { type: "ping"; ts: number }
  | { type: "command"; id: string; command: ExtCommand };

type ClientMessage =
  | { type: "pong"; ts: number }
  | ({ type: "ack" } & ExtAck)
  | ({ type: "event" } & ExtEvent);

interface PendingCommand {
  resolve: (ack: ExtAck) => void;
  timer: NodeJS.Timeout;
  command: ExtCommand;
  dispatchedAt: number;
}

interface ClientState {
  user: User;
  ws: WebSocket;
  pending: Map<string, PendingCommand>;
  lastPong: number;
  listeners: Set<(evt: ExtEvent) => void>;
}

const byUser = new Map<number, Set<ClientState>>();

const PING_INTERVAL_MS = 20_000;
const PONG_GRACE_MS = 45_000;
// Browser ops can legitimately take a while — `browser_wait_for` polls
// up to 30 s by default, navigation on a slow site eats 10–15 s. Set
// the wire-level cap higher than companion's 10 s so we don't time out
// inside CDP's own waits.
const COMMAND_TIMEOUT_MS = 60_000;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function registerCommandFlight(
  state: ClientState,
  id: string,
  command: ExtCommand,
  timeoutMs: number,
): Promise<ExtAck> {
  return new Promise<ExtAck>((resolve) => {
    const timer = setTimeout(() => {
      if (!state.pending.has(id)) return;
      state.pending.delete(id);
      resolve({ id, ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    state.pending.set(id, {
      resolve,
      timer,
      command,
      dispatchedAt: Date.now(),
    });
    send(state.ws, { type: "command", id, command });
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoExtBridgeWs: ReturnType<typeof buildExtBridgeWs> | undefined;
}

function buildExtBridgeWs() {
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
    console.log(`[ext-bridge-ws] connected user=${user.id} (${user.name})`);

    send(ws, {
      type: "hello",
      user: { id: user.id, name: user.name, role: user.role },
    });

    const pingTimer = setInterval(() => {
      if (Date.now() - state.lastPong > PONG_GRACE_MS) {
        console.warn(
          `[ext-bridge-ws] user=${user.id} pong timeout, closing`,
        );
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
          pending.resolve({
            id: msg.id,
            ok: msg.ok,
            error: msg.error,
            result: msg.result,
          });
        }
        return;
      }
      if (msg.type === "event") {
        for (const listener of state.listeners) {
          try {
            listener({ event: msg.event, data: msg.data });
          } catch (err) {
            console.error("[ext-bridge-ws] listener threw", err);
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
      console.log(`[ext-bridge-ws] disconnected user=${user.id}`);
    });
  });

  return {
    wss,
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      // Origin gate. Extension origin looks like
      // chrome-extension://<32-char-id>. We accept those plus the
      // dashboard's own host (so a dev page can also speak this
      // protocol if needed), and we honour an explicit allowlist when
      // configured.
      const origin = req.headers.origin;
      const host = req.headers.host;
      const xfHost = req.headers["x-forwarded-host"];
      if (!isOriginAllowed(origin, host, xfHost)) {
        console.warn(
          `[ext-bridge-ws] 403 origin mismatch — origin=${origin} host=${host} xf-host=${xfHost ?? "-"}`,
        );
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      // Auth: prefer the cookie header (parsed + signature-verified by
      // sessionIdFromHeader). Chrome MV3 service workers can't send
      // Cookie on a WebSocket handshake though, so we also accept the
      // signed cookie value as a query param: ?session=<sid>.<mac>.
      // verifySigned MUST run on the query value too, otherwise the
      // signed form ends up passed straight into userFromSession,
      // which queries `sessions WHERE id = '<sid>.<mac>'` and never
      // matches the unsigned id stored in the DB. That mismatch was
      // the actual cause of the 401 + close-code-1006 the popup was
      // surfacing.
      let sid: string | null = sessionIdFromHeader(req.headers.cookie);
      if (!sid) {
        try {
          const u = new URL(req.url ?? "", `http://${req.headers.host}`);
          const raw = u.searchParams.get("session");
          if (raw) sid = verifySigned(raw);
        } catch {
          /* ignore */
        }
      }
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
     * Send a tool call to the user's connected extension. If the user
     * has multiple extension instances open (rare — one window per
     * machine usually), the command goes to the first one in
     * insertion order. Multi-fan-out doesn't make sense for a tool
     * call: only one tab can be the driver target at any moment.
     *
     * Returns the ack. Caller is responsible for translating ok:false
     * into an error the MCP layer surfaces to Claude.
     */
    async sendCommand(
      userId: number,
      command: ExtCommand,
      timeoutMs: number = COMMAND_TIMEOUT_MS,
    ): Promise<ExtAck> {
      const clients = byUser.get(userId);
      if (!clients || clients.size === 0) {
        return {
          id: "",
          ok: false,
          error: "no extension connected — install the Amaso extension and open the dashboard at least once",
        };
      }
      const state = clients.values().next().value as ClientState;
      const id = crypto.randomBytes(8).toString("base64url");
      return registerCommandFlight(state, id, command, timeoutMs);
    },

    subscribe(
      userId: number,
      listener: (evt: ExtEvent) => void,
    ): () => void {
      const clients = byUser.get(userId);
      if (!clients) return () => {};
      for (const state of clients) state.listeners.add(listener);
      return () => {
        const current = byUser.get(userId);
        if (!current) return;
        for (const state of current) state.listeners.delete(listener);
      };
    },

    isConnected(userId: number): boolean {
      const clients = byUser.get(userId);
      return !!clients && clients.size > 0;
    },
  };
}

function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  xForwardedHost: string | string[] | undefined,
): boolean {
  if (!origin) return false;

  // Extension-scoped allowlist via env. Comma-separated list of
  // extension IDs (the 32-char base32-ish thing in chrome://extensions).
  // When configured, we ONLY accept those IDs — same-host origin
  // rejects too. This is the prod-mode setting.
  const explicit = process.env.AMASO_EXT_BRIDGE_ALLOWED_ORIGINS;
  if (explicit && explicit.trim().length > 0) {
    const allow = new Set(
      explicit
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    // Accept either a full chrome-extension://... origin or just the
    // bare extension id.
    if (allow.has(origin)) return true;
    const m = /^chrome-extension:\/\/([a-p]{32})/.exec(origin);
    if (m && allow.has(m[1])) return true;
    return false;
  }

  // No explicit allowlist — dev fallback. Accept ANY chrome-extension
  // origin (the user obviously installed it themselves, and the
  // session-cookie check below this is the real gate) plus same-host
  // origins for parity with the rest of the dashboard's WS handlers.
  if (/^chrome-extension:\/\/[a-p]{32}/.test(origin)) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const candidates = new Set<string>();
  if (host) candidates.add(host);
  if (xForwardedHost) {
    const xf = Array.isArray(xForwardedHost)
      ? xForwardedHost[0]
      : xForwardedHost;
    if (xf) candidates.add(xf);
  }
  const stripPort = (h: string): string => h.replace(/:\d+$/, "");
  for (const c of candidates) {
    if (c === originHost) return true;
    if (stripPort(c) === stripPort(originHost)) return true;
  }
  return false;
}

export function createExtBridgeWs() {
  if (!globalThis.__amasoExtBridgeWs) {
    globalThis.__amasoExtBridgeWs = buildExtBridgeWs();
  }
  return globalThis.__amasoExtBridgeWs;
}

export async function sendExtCommand(
  userId: number,
  command: ExtCommand,
  timeoutMs?: number,
): Promise<ExtAck> {
  return (
    globalThis.__amasoExtBridgeWs?.sendCommand(userId, command, timeoutMs) ??
    Promise.resolve({
      id: "",
      ok: false,
      error: "ext-bridge not initialised",
    })
  );
}

export function isExtensionConnected(userId: number): boolean {
  return globalThis.__amasoExtBridgeWs?.isConnected(userId) ?? false;
}
