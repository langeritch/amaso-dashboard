// WebSocket bridge for /spar2 — singleton Claude CLI in WSL2 tmux.
// URL: ws://host/api/spar2
//
// Mirrors lib/terminal-ws.ts but with three differences:
//   • No projectId — singleton session per dashboard.
//   • Three-arg Origin guard from the start (terminal-ws was patched
//     2026-04-28 after PTYs silently broke through the tunnel; v2 ships
//     correct).
//   • Detach-not-kill on disconnect — closing the /spar2 tab leaves the
//     `claude` process running inside tmux so reopening the tab continues
//     the same conversation. Kill is operator-explicit only.
//
// Inbound messages (JSON):
//   { type: "input", data: "..." }   — stdin bytes
//   { type: "resize", cols, rows }   — PTY resize
//   { type: "start", cols, rows }    — start session if not running
//   { type: "kill" }                 — hard-kill the tmux session
// Outbound messages:
//   { type: "data", data: "..." }
//   { type: "status", ... }
//   { type: "exit", exitCode, signal }
//   { type: "error", message }

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { sessionIdFromHeader, userFromSession } from "./auth-core";
import type { User } from "./db";
import {
  killTmux,
  resize as resizeSession,
  start as startSession,
  status as getStatus,
  subscribe,
  subscribeExit,
  write as writeToSession,
} from "./spar2-session";

declare global {
  // eslint-disable-next-line no-var
  var __amasoSpar2Ws: ReturnType<typeof build> | undefined;
}

function build() {
  const wss = new WebSocketServer({ noServer: true });

  function send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  wss.on("connection", (ws, req) => {
    const _user = (req as IncomingMessage & { amasoUser?: User }).amasoUser;

    // Replay current state to the new client.
    const initial = getStatus();
    send(ws, { type: "status", ...initial });
    if (initial.running && initial.scrollback) {
      send(ws, { type: "data", data: initial.scrollback });
    }

    let unsubData = subscribe((data) => send(ws, { type: "data", data }));
    let unsubExit = subscribeExit((payload) =>
      send(ws, { type: "exit", ...payload }),
    );

    ws.on("message", (raw) => {
      let msg: { type: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        writeToSession(msg.data);
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        resizeSession(msg.cols, msg.rows);
      } else if (msg.type === "start") {
        // Idempotent: if already running, just re-replay status. Don't
        // double-spawn or double-banner.
        if (getStatus().running) {
          send(ws, { type: "status", ...getStatus() });
          return;
        }
        try {
          startSession({
            cols: typeof msg.cols === "number" ? msg.cols : 100,
            rows: typeof msg.rows === "number" ? msg.rows : 30,
          });
          // Re-subscribe — previous handlers no-op'd because the session
          // didn't exist when they were registered.
          unsubData();
          unsubExit();
          unsubData = subscribe((d) => send(ws, { type: "data", data: d }));
          unsubExit = subscribeExit((p) => send(ws, { type: "exit", ...p }));
          send(ws, { type: "status", ...getStatus() });
          send(ws, {
            type: "data",
            data: "\r\n\x1b[36m(starting Hermes in WSL tmux…)\x1b[0m\r\n",
          });
        } catch (err) {
          send(ws, {
            type: "error",
            message: err instanceof Error ? err.message : "start_failed",
          });
        }
      } else if (msg.type === "kill") {
        // Operator-explicit hard kill. Closing the tab does NOT do this —
        // see ws.on("close") below.
        void killTmux();
      }
    });

    ws.on("close", () => {
      // Detach: stop streaming to *this* WS but leave the tmux session
      // (and therefore the `claude` conversation) running for the next
      // attaching client. This is THE feature that makes /spar2 different
      // from /projects/[id] — your sparring partner doesn't reset every
      // time you close a tab.
      unsubData();
      unsubExit();
    });
    ws.on("error", () => {
      unsubData();
      unsubExit();
    });
  });

  return {
    wss,
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      // CSWSH guard with X-Forwarded-Host support — Cloudflare Tunnel
      // rewrites Host:localhost so a strict Host==Origin check would 403
      // every legit prod connection. (See lib/terminal-ws.ts for the
      // 2026-04-28 incident that established this pattern.)
      const origin = req.headers.origin;
      const host = req.headers.host;
      const xfHost = req.headers["x-forwarded-host"];
      if (!originMatchesHost(origin, host, xfHost)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      // Auth: same session cookie as the rest of the dashboard, admin only.
      // Spar v2 streams a live root shell inside WSL — anything less than
      // admin would be a privilege-escalation foothold.
      const sid = sessionIdFromHeader(req.headers.cookie);
      const user = sid ? userFromSession(sid) : null;
      if (!user || user.role !== "admin") {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      (req as IncomingMessage & { amasoUser?: User }).amasoUser = user;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    },
  };
}

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

export function createSpar2Ws() {
  if (!globalThis.__amasoSpar2Ws) globalThis.__amasoSpar2Ws = build();
  return globalThis.__amasoSpar2Ws;
}
