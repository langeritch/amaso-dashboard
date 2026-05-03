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

export interface SparMessagePayload {
  conversationId: number;
  message: {
    id: number;
    role: "user" | "assistant" | "system";
    content: string;
    toolCalls: unknown | null;
    createdAt: number;
  };
}

/**
 * Remote-control action payload. Pushed when the spar voice
 * assistant (or any authenticated caller of /api/spar/remote-control)
 * wants to drive the dashboard UI for the user. The frontend listens
 * for these and dispatches into local state — toggling autopilot,
 * opening sidebars, starting a new conversation, setting the
 * directive, etc.
 *
 * The action is the wire-level discriminator. Frontend translates
 * each action into the appropriate UI mutation. Unknown actions are
 * silently dropped on the client so adding new ones is a one-sided
 * deploy.
 */
export type SparRemoteControlAction =
  | { action: "toggle_autopilot"; value: boolean }
  | { action: "open_sidebar"; side: "left" | "right" }
  | { action: "close_sidebar"; side: "left" | "right" }
  | { action: "new_conversation" }
  | { action: "set_directive"; value: string };

export interface SparRemoteControlPayload {
  /** Monotonic id used by the frontend to ack back which action it
   *  applied. Generated server-side per request. */
  id: string;
  /** Wall-clock when the API route handled the request. The
   *  visual-feedback flash uses this to ignore replays older than
   *  ~5s in case a ws reconnect re-delivers a stale buffer. */
  issuedAt: number;
  payload: SparRemoteControlAction;
}

export interface SparConversationPayload {
  conversationId: number;
  /** Echoed only when the title changed this broadcast — null
   *  otherwise so consumers can tell "title update" apart from
   *  "drift notice update" without a separate event type. */
  title?: string | null;
  /** Drift notice text or null when cleared. Omitted when this
   *  broadcast doesn't touch the drift state. */
  driftNotice?: string | null;
  updatedAt: number;
}

export type ServerMessage =
  | { type: "hello"; user: { id: number; name: string; role: User["role"] } }
  | { type: "file"; event: PublicFileEvent }
  | { type: "history"; event: PublicHistoryEvent }
  | { type: "remark"; action: "added" | "deleted"; projectId: string; path: string; remarkId: number }
  | { type: "chat:message"; channelId: number; message: MessageView }
  | { type: "chat:remark"; channelId: number; projectId: string; remarkId: number }
  | { type: "projects:changed" }
  | { type: "graph:changed" }
  | {
      type: "dispatch_completed";
      projectId: string;
      projectName: string;
      dispatchId: string;
      /** Stage 3 of remark #285: which terminal session for the project
       *  just went idle. Equals projectId for the legacy single-session
       *  case so old clients that ignore this field keep working
       *  unchanged. Multi-session UIs use it to attribute the auto-
       *  report to the correct row. */
      sessionId?: string;
      /** 1-based ordinal among the project's currently-live sessions
       *  at fire-time. Optional — purely cosmetic ("session #2") for
       *  the auto-report bubble. Computed at broadcast time so the UI
       *  doesn't have to re-derive it from worker-status. */
      sessionOrdinal?: number;
    }
  | { type: "spar:message"; payload: SparMessagePayload }
  | { type: "spar:conversation"; payload: SparConversationPayload }
  | { type: "spar:remote_control"; payload: SparRemoteControlPayload };

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
    broadcastProjectsChanged() {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        send(ws, { type: "projects:changed" });
      }
    },
    // Brain page graph mutated. Global broadcast — the brain page is
    // admin-scoped and a refetch is cheap, so we don't bother with
    // per-user targeting like dispatch_completed does.
    broadcastGraphChanged() {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        send(ws, { type: "graph:changed" });
      }
    },
    // True if any currently-connected /api/sync socket belongs to
    // `userId`. Used by the proactive-turn pipeline to gate
    // dispatch-complete summaries: when the user has a spar tab open
    // the existing client-side queueCompletion path already produces
    // a transcript-quality reply (Opus, voice-mode aware), so server
    // re-running the summary on top would duplicate the bubble.
    hasSparUserSocket(userId: number): boolean {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        if (state.user.id !== userId) continue;
        if (ws.readyState !== WebSocket.OPEN) continue;
        return true;
      }
      return false;
    },
    // Spar conversation message persisted — fan out to every socket
    // belonging to the same user so a thread the user just typed into
    // on the laptop appears immediately on the phone (and vice versa).
    // Other users never see these. No subscription required: a user's
    // spar tab implicitly subscribes by having an authenticated socket
    // open. The payload carries a conversationId so the client can
    // ignore broadcasts for threads it isn't currently viewing.
    broadcastSparMessage(userId: number, payload: SparMessagePayload) {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        if (state.user.id !== userId) continue;
        send(ws, { type: "spar:message", payload });
      }
    },
    // Remote-control actions issued by the spar voice assistant /
    // /api/spar/remote-control. Per-user fan-out so one operator's
    // "toggle autopilot" doesn't ripple into a teammate's tab.
    broadcastSparRemoteControl(
      userId: number,
      payload: SparRemoteControlPayload,
    ) {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        if (state.user.id !== userId) continue;
        send(ws, { type: "spar:remote_control", payload });
      }
    },
    // Conversation-level updates: title rename + drift notice. Same
    // per-user fan-out as broadcastSparMessage; the sidebar consumes
    // these to reorder + retitle threads in real time without a
    // polling round-trip.
    broadcastSparConversation(userId: number, payload: SparConversationPayload) {
      for (const ws of wss.clients) {
        const state = clients.get(ws);
        if (!state) continue;
        if (state.user.id !== userId) continue;
        send(ws, { type: "spar:conversation", payload });
      }
    },
    // Targeted at the user who fired the dispatch — we don't want one
    // operator's "task done" pings echoing into a teammate's open spar
    // tab. The terminal idle-timer call site has the userId from the
    // dispatch log entry.
    broadcastDispatchCompleted(
      userId: number,
      projectId: string,
      projectName: string,
      dispatchId: string,
      sessionId?: string,
      sessionOrdinal?: number,
    ) {
      let matched = 0;
      let total = 0;
      for (const ws of wss.clients) {
        total++;
        const state = clients.get(ws);
        if (!state) continue;
        if (state.user.id !== userId) continue;
        matched++;
        send(ws, {
          type: "dispatch_completed",
          projectId,
          projectName,
          dispatchId,
          // Both fields are omitted from the wire payload when the
          // caller didn't supply them, so legacy single-session
          // dispatches send exactly the pre-Stage-3 message shape.
          ...(sessionId ? { sessionId } : {}),
          ...(sessionOrdinal ? { sessionOrdinal } : {}),
        });
      }
      console.log(
        `[ws] dispatch_completed broadcast user=${userId} project=${projectId} session=${sessionId ?? "<default>"} dispatchId=${dispatchId} → ${matched}/${total} sockets`,
      );
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

export function broadcastProjectsChanged() {
  globalThis.__amasoWs?.broadcastProjectsChanged();
}

/** Notify every connected client that graph_nodes / graph_edges changed.
 *  Brain page subscribers refetch /api/graph on receipt. */
export function broadcastGraphChanged() {
  globalThis.__amasoWs?.broadcastGraphChanged();
}

/** True if `userId` currently has at least one open /api/sync
 *  socket (i.e. their spar tab is live). Returns false during cron
 *  ticks / dashboard restarts when nobody is connected. */
export function hasSparUserSocket(userId: number): boolean {
  return globalThis.__amasoWs?.hasSparUserSocket(userId) ?? false;
}

/** Push a freshly-persisted spar message to every connection owned
 *  by `userId`. Used by /api/spar/conversations/[id]/messages and the
 *  /api/spar streaming route to keep multiple devices in sync. Other
 *  users' connections never receive these payloads. */
export function broadcastSparMessage(
  userId: number,
  payload: SparMessagePayload,
) {
  globalThis.__amasoWs?.broadcastSparMessage(userId, payload);
}

/** Push a conversation metadata update (title rename / drift notice)
 *  to every socket the user has open. The auto-namer fires this from
 *  the streaming route's finalize step. */
export function broadcastSparConversation(
  userId: number,
  payload: SparConversationPayload,
) {
  globalThis.__amasoWs?.broadcastSparConversation(userId, payload);
}

/** Push a remote-control action to every socket the user has open.
 *  Used by /api/spar/remote-control so the spar voice assistant can
 *  drive UI state (autopilot, sidebars, conversations, directive)
 *  remotely. */
export function broadcastSparRemoteControl(
  userId: number,
  payload: SparRemoteControlPayload,
) {
  globalThis.__amasoWs?.broadcastSparRemoteControl(userId, payload);
}

/** Notify the spar tab(s) of the dispatching user that a project's
 *  Claude Code session just returned to idle after a dispatched prompt.
 *  Spar uses this to auto-fetch the terminal scrollback and report
 *  back without the user having to ask. Targeted at one user — see
 *  buildWs().broadcastDispatchCompleted for the rationale. */
export function broadcastDispatchCompleted(
  userId: number,
  projectId: string,
  projectName: string,
  dispatchId: string,
  sessionId?: string,
  sessionOrdinal?: number,
) {
  if (!globalThis.__amasoWs) {
    console.warn(
      `[ws] broadcastDispatchCompleted dropped — WS singleton not initialized (project=${projectId} dispatchId=${dispatchId})`,
    );
    return;
  }
  globalThis.__amasoWs.broadcastDispatchCompleted(
    userId,
    projectId,
    projectName,
    dispatchId,
    sessionId,
    sessionOrdinal,
  );
}
