// WebSocket bridge for /api/browser — the live remote-Chromium viewer.
// Mirrors the terminal-ws.ts pattern (Origin guard + cookie auth +
// noServer upgrade). One connection per viewer; multiple viewers per
// user share a single LiveBrowser via lib/browser-stream.ts.
//
// Outbound messages (server → client):
//   { type: "frame",      data: <base64 jpeg>, width, height }
//   { type: "navigation", tabId, url, title }
//   { type: "tabs",       tabs: [{tabId,url,title,active}], activeTabId }
//   { type: "ready",      width, height, recordingId }
//   { type: "session_ended", recordingId }   — stopSession sends this
//                                               immediately before
//                                               closing viewers so the
//                                               client skips reconnect.
//   { type: "error",      message }
//
// Inbound messages (client → server). Mouse/keyboard/navigate/back/
// forward/reload all target whichever tab is currently active —
// switching tabs is a separate message so the input pipe stays
// coherent with the frames the user sees.
//   { type: "mousemove",  x, y }
//   { type: "mousedown",  x, y, button }
//   { type: "mouseup",    x, y, button }
//   { type: "wheel",      x, y, deltaX, deltaY }
//   { type: "keydown",    key }
//   { type: "keyup",      key }
//   { type: "type",       text }       — bulk text (paste / typed string)
//   { type: "navigate",   url }
//   { type: "back" } | { type: "forward" } | { type: "reload" }
//   { type: "new_tab",    url? }
//   { type: "close_tab",  tabId }
//   { type: "switch_tab", tabId }
//   { type: "stop" }                   — tear down the LiveBrowser

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  SESSION_COOKIE,
  sessionIdFromHeader,
  userFromSession,
  verifySigned,
} from "./auth-core";
import {
  acquireSession,
  attachViewer,
  closeTab,
  detachViewer,
  goBack,
  goForward,
  keyDown,
  keyUp,
  mouseDown,
  mouseMove,
  mouseUp,
  navigate,
  newTab,
  reload,
  STREAM_VIEWPORT,
  stopSession,
  switchTab,
  typeText,
  wheel,
} from "./browser-stream";
import type { User } from "./db";

declare global {
  // eslint-disable-next-line no-var
  var __amasoBrowserWs: ReturnType<typeof build> | undefined;
}

function build() {
  const wss = new WebSocketServer({ noServer: true });

  function send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  wss.on("connection", async (ws, req) => {
    const tag = `[browser-ws ${req.headers["sec-websocket-key"]?.slice(0, 6) ?? "?"}]`;
    const meta = req as IncomingMessage & {
      amasoUser?: User;
      amasoSignedCookie?: string;
      amasoOrigin?: string;
    };
    const user = meta.amasoUser;
    const signed = meta.amasoSignedCookie;
    const origin = meta.amasoOrigin;
    if (!user || !signed || !origin) {
      console.error(`${tag} connection without amaso meta — dropping`);
      send(ws, { type: "error", message: "missing_auth" });
      ws.close();
      return;
    }
    const url = new URL(req.url ?? "", "http://localhost");
    const recordingId = url.searchParams.get("recording");
    console.log(
      `${tag} connection user=${user.id} recording=${recordingId ?? "-"} origin=${origin}`,
    );

    let live;
    try {
      live = await acquireSession({
        userId: user.id,
        signedSessionCookie: signed,
        recordingId,
        dashboardOrigin: origin,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "launch_failed";
      console.error(`${tag} acquireSession failed:`, err);
      send(ws, { type: "error", message: msg });
      ws.close();
      return;
    }

    if (!attachViewer(user.id, ws)) {
      console.error(`${tag} attachViewer failed user=${user.id}`);
      send(ws, { type: "error", message: "attach_failed" });
      ws.close();
      return;
    }

    console.log(
      `${tag} ready user=${user.id} viewers=${live.viewers.size} recording=${live.recordingId ?? "-"}`,
    );
    send(ws, {
      type: "ready",
      width: STREAM_VIEWPORT.width,
      height: STREAM_VIEWPORT.height,
      recordingId: live.recordingId,
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const t = msg.type;
      if (typeof t !== "string") return;
      switch (t) {
        case "mousemove":
          if (isXY(msg)) void mouseMove(user.id, msg.x, msg.y);
          break;
        case "mousedown":
          if (isXY(msg)) void mouseDown(user.id, msg.x, msg.y, asButton(msg.button));
          break;
        case "mouseup":
          if (isXY(msg)) void mouseUp(user.id, msg.x, msg.y, asButton(msg.button));
          break;
        case "wheel":
          if (isXY(msg) && typeof msg.deltaX === "number" && typeof msg.deltaY === "number") {
            void wheel(user.id, msg.x, msg.y, msg.deltaX, msg.deltaY);
          }
          break;
        case "keydown":
          if (typeof msg.key === "string") void keyDown(user.id, msg.key);
          break;
        case "keyup":
          if (typeof msg.key === "string") void keyUp(user.id, msg.key);
          break;
        case "type":
          if (typeof msg.text === "string") void typeText(user.id, msg.text);
          break;
        case "navigate":
          if (typeof msg.url === "string") void navigate(user.id, msg.url);
          break;
        case "back":
          void goBack(user.id);
          break;
        case "forward":
          void goForward(user.id);
          break;
        case "reload":
          void reload(user.id);
          break;
        case "new_tab":
          void newTab(
            user.id,
            typeof msg.url === "string" ? msg.url : undefined,
          );
          break;
        case "close_tab":
          if (typeof msg.tabId === "number") void closeTab(user.id, msg.tabId);
          break;
        case "switch_tab":
          if (typeof msg.tabId === "number") void switchTab(user.id, msg.tabId);
          break;
        case "stop":
          void stopSession(user.id);
          break;
      }
    });

    ws.on("close", (code, reason) => {
      console.log(
        `${tag} client close user=${user.id} code=${code} reason=${reason?.toString() || "-"}`,
      );
      detachViewer(user.id, ws);
    });
    ws.on("error", (err) => {
      console.warn(`${tag} client error user=${user.id}:`, err?.message ?? err);
      detachViewer(user.id, ws);
    });
  });

  return {
    wss,
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const tag = `[browser-ws ${req.headers["sec-websocket-key"]?.slice(0, 6) ?? "?"}]`;
      const reqOrigin = req.headers.origin;
      const host = req.headers.host;
      const xfHost = req.headers["x-forwarded-host"];
      const xfProto = req.headers["x-forwarded-proto"];
      const cookieRaw = req.headers.cookie;
      console.log(
        `${tag} upgrade url=${req.url} host=${host} xf-host=${xfHost ?? "-"} ` +
          `xf-proto=${xfProto ?? "-"} origin=${reqOrigin ?? "-"} ` +
          `cookie=${cookieRaw ? `${cookieRaw.length}b` : "missing"}`,
      );

      // CSWSH guard. Without it, a malicious cross-origin page visited
      // by a logged-in user could open this socket and drive a real
      // browser as them.
      if (!originMatchesHost(reqOrigin, host, xfHost)) {
        console.warn(
          `${tag} 403 origin mismatch — origin=${reqOrigin} host=${host} xf-host=${xfHost}`,
        );
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const sid = sessionIdFromHeader(req.headers.cookie);
      if (!sid) {
        console.warn(`${tag} 401 no session id in cookie`);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const user = userFromSession(sid);
      if (!user) {
        console.warn(`${tag} 401 session id present but no matching user`);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      // Pull the raw signed cookie value (decoded but still signed) so
      // we can replant it inside the headless context.
      const signed = extractRawCookie(req.headers.cookie, SESSION_COOKIE);
      if (!signed || !verifySigned(signed)) {
        console.warn(`${tag} 401 signed cookie missing or invalid`);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      // The headless browser fetches from the same Node server it was
      // launched alongside — use the loopback so DNS/cloudflared aren't
      // in the path, but build the origin from the request so dev/prod
      // and IPv4/IPv6 all line up.
      const port = process.env.PORT ?? "3737";
      const inboundOrigin = `http://127.0.0.1:${port}`;

      const meta = req as IncomingMessage & {
        amasoUser?: User;
        amasoSignedCookie?: string;
        amasoOrigin?: string;
      };
      meta.amasoUser = user;
      meta.amasoSignedCookie = signed;
      meta.amasoOrigin = inboundOrigin;
      console.log(
        `${tag} upgrade accepted user=${user.id} (${user.email}) → handing off to ws server`,
      );
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
  // Cloudflared (and most tunnel/proxy setups) preserve the original
  // Host header when forwarding to origin, so a strict host-equality
  // check is the right default. But `Origin` includes a port only
  // when non-standard, while `Host` arriving via cloudflared on the
  // public hostname has no port — strip the port from Origin if its
  // scheme implies the default. Also accept `X-Forwarded-Host` as a
  // fallback in case the proxy rewrote `Host` to the loopback.
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

function extractRawCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(/;\s*/)) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx);
    const v = pair.slice(idx + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function isXY(msg: Record<string, unknown>): msg is { x: number; y: number } & Record<string, unknown> {
  return typeof msg.x === "number" && typeof msg.y === "number";
}

function asButton(raw: unknown): "left" | "right" | "middle" {
  if (raw === "right") return "right";
  if (raw === "middle") return "middle";
  return "left";
}

export function createBrowserWs() {
  if (!globalThis.__amasoBrowserWs) globalThis.__amasoBrowserWs = build();
  return globalThis.__amasoBrowserWs;
}
