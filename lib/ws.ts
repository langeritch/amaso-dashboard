import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { getWatcher, type FileEvent } from "./watcher";
import { getHistory, type HistoryEvent } from "./history";
import { sessionIdFromHeader, userFromSession } from "./auth-core";
import { canAccessProject } from "./access";
import { canUseChannel, type MessageView } from "./chat";
import type { User } from "./db";

type ClientMessage =
  | { type: "subscribe"; projectId: string }
  | { type: "unsubscribe"; projectId: string }
  | { type: "chat:subscribe"; channelId: number }
  | { type: "chat:unsubscribe"; channelId: number };

type PublicFileEvent = Omit<FileEvent, "absPath">;

type PublicHistoryEvent = Pick<
  HistoryEvent,
  "id" | "projectId" | "type" | "path" | "ts"
>;

export type ServerMessage =
  | { type: "hello"; user: { id: number; name: string; role: User["role"] } }
  | { type: "file"; event: PublicFileEvent }
  | { type: "history"; event: PublicHistoryEvent }
  | { type: "remark"; action: "added" | "deleted"; projectId: string; path: string; remarkId: number }
  | { type: "chat:message"; channelId: number; message: MessageView }
  | { type: "chat:remark"; channelId: number; projectId: string; remarkId: number };

interface ClientState {
  user: User;
  subscriptions: Set<string>;
  chatSubscriptions: Set<number>;
}

const clients = new WeakMap<WebSocket, ClientState>();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Wrap the actual send so a failure on one client (closed mid-flight,
  // backpressure throw, JSON serialisation oddity) can't propagate up
  // and abort the broadcast loop. Each call site iterates wss.clients
  // — without this guard, the first throw leaves every later client
  // un-notified and the operator with no obvious symptom.
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.warn("[ws] send failed for one client (ignored):", err);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoWs: ReturnType<typeof buildWs> | undefined;
}

function buildWs() {
  const wss = new WebSocketServer({ noServer: true });

  // Pipe watcher events to subscribed clients
  getWatcher().on("file", (event: FileEvent) => {
    // Drop the absolute path before broadcasting
    const pub: PublicFileEvent = {
      type: event.type,
      projectId: event.projectId,
      relPath: event.relPath,
    };
    for (const ws of wss.clients) {
      const state = clients.get(ws);
      if (!state) continue;
      if (!state.subscriptions.has(event.projectId)) continue;
      if (!canAccessProject(state.user, event.projectId)) continue;
      send(ws, { type: "file", event: pub });
    }
    // Feed history (async): compute diff + store snapshot
    if (
      event.type === "add" ||
      event.type === "change" ||
      event.type === "unlink"
    ) {
      void getHistory().record(
        event.projectId,
        event.type,
        event.relPath,
        event.absPath,
      );
    }
  });

  getHistory().on("event", (evt: HistoryEvent) => {
    const pub: PublicHistoryEvent = {
      id: evt.id,
      projectId: evt.projectId,
      type: evt.type,
      path: evt.path,
      ts: evt.ts,
    };
    for (const ws of wss.clients) {
      const state = clients.get(ws);
      if (!state) continue;
      if (!state.subscriptions.has(evt.projectId)) continue;
      if (!canAccessProject(state.user, evt.projectId)) continue;
      send(ws, { type: "history", event: pub });
    }
  });

  wss.on("connection", (ws, req: IncomingMessage & { amasoUser?: User }) => {
    const user = req.amasoUser!;
    clients.set(ws, {
      user,
      subscriptions: new Set(),
      chatSubscriptions: new Set(),
    });
    send(ws, {
      type: "hello",
      user: { id: user.id, name: user.name, role: user.role },
    });

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      const state = clients.get(ws);
      if (!state) return;
      if (msg.type === "subscribe") {
        if (canAccessProject(state.user, msg.projectId)) {
          state.subscriptions.add(msg.projectId);
        }
      } else if (msg.type === "unsubscribe") {
        state.subscriptions.delete(msg.projectId);
      } else if (msg.type === "chat:subscribe") {
        if (canUseChannel(state.user, msg.channelId)) {
          state.chatSubscriptions.add(msg.channelId);
        }
      } else if (msg.type === "chat:unsubscribe") {
        state.chatSubscriptions.delete(msg.channelId);
      }
    });
  });

  return {
    wss,
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      // CSWSH guard: SameSite=lax on the session cookie already blocks
      // most cross-origin handshakes, but this is cheap defence-in-depth
      // and matches the pattern used by terminal-ws / browser-ws. A
      // logged-in user visiting attacker.com shouldn't be able to have
      // the attacker subscribe to their project file events / chat.
      const origin = req.headers.origin;
      const host = req.headers.host;
      const xfHost = req.headers["x-forwarded-host"];
      if (!originMatchesHost(origin, host, xfHost)) {
        console.warn(
          `[ws] 403 origin mismatch — origin=${origin} host=${host} xf-host=${xfHost ?? "-"}`,
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
    broadcastRemark(
      projectId: string,
      filePath: string,
      remarkId: number,
      action: "added" | "deleted",
    ) {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        if (canAccessProject(state.user, projectId)) {
          if (state.subscriptions.has(projectId)) {
            send(ws, {
              type: "remark",
              action,
              projectId,
              path: filePath,
              remarkId,
            });
          }
          // Also notify chat clients subscribed to that project's channel —
          // remarks render inline in project channel feeds.
          for (const chId of state.chatSubscriptions) {
            // We don't know the channel→project mapping without a DB round-trip.
            // Consumer handles this via broadcastChatRemark below.
            void chId;
          }
        }
      }
    },
    broadcastChatMessage(channelId: number, message: MessageView) {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        if (!state.chatSubscriptions.has(channelId)) continue;
        if (!canUseChannel(state.user, channelId)) continue;
        send(ws, { type: "chat:message", channelId, message });
      }
    },
    broadcastChatRemark(
      channelId: number,
      projectId: string,
      remarkId: number,
    ) {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        if (!state.chatSubscriptions.has(channelId)) continue;
        if (!canUseChannel(state.user, channelId)) continue;
        send(ws, { type: "chat:remark", channelId, projectId, remarkId });
      }
    },
  };
}

/**
 * Mirror of the helper in lib/browser-ws.ts — kept duplicated rather
 * than shared so each WS module stays self-contained and the CSWSH
 * guard at the top of every handleUpgrade is one obvious block.
 *
 * Accepts both Host and X-Forwarded-Host because the dashboard runs
 * behind a Cloudflare tunnel in production: cloudflared rewrites Host
 * to the loopback origin, so a strict Host==Origin check would 403
 * every legitimate prod connection.
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

export function createWsServer() {
  if (!globalThis.__amasoWs) globalThis.__amasoWs = buildWs();
  return globalThis.__amasoWs;
}

/** Allow API routes to push remark events after mutating the DB. */
export function broadcastRemark(
  projectId: string,
  filePath: string,
  remarkId: number,
  action: "added" | "deleted",
) {
  globalThis.__amasoWs?.broadcastRemark(projectId, filePath, remarkId, action);
}

export function broadcastChatMessage(channelId: number, message: MessageView) {
  globalThis.__amasoWs?.broadcastChatMessage(channelId, message);
}

export function broadcastChatRemark(
  channelId: number,
  projectId: string,
  remarkId: number,
) {
  globalThis.__amasoWs?.broadcastChatRemark(channelId, projectId, remarkId);
}
