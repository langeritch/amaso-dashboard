// WebSocket bridge voor per-project Claude terminals.
// URL: ws://host/api/terminal?projectId=<id>
// Inkomende messages (JSON):
//   { type: "input", data: "string" }     — stdin bytes
//   { type: "resize", cols, rows }        — PTY resize
//   { type: "start", cols, rows }         — start session if not running
//   { type: "stop" }                      — kill session
// Uitgaande messages:
//   { type: "data", data: "..." }         — PTY output chunk
//   { type: "status", ... }               — current session state
//   { type: "exit", exitCode, signal }    — process exited

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { sessionIdFromHeader, userFromSession } from "./auth-core";
import type { User } from "./db";
import {
  getStatus,
  resize as resizeSession,
  start as startSession,
  stop as stopSession,
  subscribe,
  write as writeToSession,
} from "./terminal";

declare global {
  // eslint-disable-next-line no-var
  var __amasoTermWs: ReturnType<typeof build> | undefined;
}

function build() {
  const wss = new WebSocketServer({ noServer: true });

  function send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      send(ws, { type: "error", message: "missing_project_id" });
      ws.close();
      return;
    }
    // The authenticated user is stashed on the req by handleUpgrade. Used to
    // attribute keystrokes — the idle-push after Claude finishes only pings
    // whoever submitted the prompt.
    const user = (req as IncomingMessage & { amasoUser?: User }).amasoUser;

    // Replay scrollback on connect (new session or reconnect)
    const status = getStatus(projectId);
    send(ws, { type: "status", ...status });
    if (status.running && status.scrollback) {
      send(ws, { type: "data", data: status.scrollback });
    }

    let unsubscribe = subscribe(
      projectId,
      (data) => send(ws, { type: "data", data }),
      (payload) => {
        send(ws, { type: "exit", ...payload });
      },
    );

    ws.on("message", (raw) => {
      let msg: {
        type: string;
        data?: string;
        cols?: number;
        rows?: number;
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        writeToSession(projectId, msg.data, user?.id ?? null);
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        resizeSession(projectId, msg.cols, msg.rows);
      } else if (msg.type === "start") {
        // If already running, just replay state — don't spawn twice, don't
        // write the "(starting…)" banner again.
        if (getStatus(projectId).running) {
          send(ws, { type: "status", ...getStatus(projectId) });
          return;
        }
        try {
          startSession(
            projectId,
            typeof msg.cols === "number" ? msg.cols : 100,
            typeof msg.rows === "number" ? msg.rows : 30,
          );
          // Re-subscribe now that there's a live emitter. The previous
          // unsubscribe() no-op'd because the session didn't exist yet.
          unsubscribe();
          const u2 = subscribe(
            projectId,
            (data) => send(ws, { type: "data", data }),
            (payload) => send(ws, { type: "exit", ...payload }),
          );
          // Replace the cleanup function the "close" handler uses
          unsubscribe = u2;
          send(ws, { type: "status", ...getStatus(projectId) });
          send(ws, {
            type: "data",
            data: "\r\n\x1b[36m(starting Claude session…)\x1b[0m\r\n",
          });
        } catch (err) {
          send(ws, {
            type: "error",
            message: err instanceof Error ? err.message : "start_failed",
          });
        }
      } else if (msg.type === "stop") {
        stopSession(projectId);
      }
    });

    ws.on("close", () => {
      unsubscribe();
    });
    ws.on("error", () => {
      unsubscribe();
    });
  });

  return {
    wss,
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      // CSWSH guard: browsers attach cookies to cross-origin WS handshakes.
      // Without an Origin check, a malicious page visited by a logged-in
      // admin could open this socket and drive the PTY (full RCE).
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (!originMatchesHost(origin, host)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      // Auth: same session cookie as the rest of the dashboard, admin-only
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
): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createTerminalWs() {
  if (!globalThis.__amasoTermWs) globalThis.__amasoTermWs = build();
  return globalThis.__amasoTermWs;
}
