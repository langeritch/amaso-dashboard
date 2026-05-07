// Amaso Recorder + Driver — background service worker.
//
// Two responsibilities, kept in one worker because MV3 only allows one:
//
//   1. Recorder (legacy): receives event batches from content scripts,
//      queues them, flushes to the dashboard's recording endpoint.
//   2. Driver: opens a persistent WebSocket to the dashboard's
//      ext-bridge, receives browser_* tool calls, dispatches them to
//      driver.js (which talks CDP via chrome.debugger), sends acks back.
//
// Both share `dashboardOrigin` from chrome.storage.local — populated
// either by the recorder fragment hook (#recording=<id>) or, if the
// user only uses the driver, by the popup's "Connect to dashboard"
// flow which writes the origin manually.
//
// Wire format for the recorder events matches the RecordingEvent type
// in types/recording.ts — keep in sync by hand.
//
// Wire format for the ext-bridge is documented in lib/ext-bridge-ws.ts.

import { runTool, setActiveDriverTab, getActiveDriverTab } from "./driver.js";

const FLUSH_INTERVAL_MS = 1500;
const MAX_BATCH = 50;

let queue = [];
let flushing = false;
let state = {
  sessionId: null,
  dashboardOrigin: null,
};

// Hydrate state from storage on each cold start of the worker. MV3
// can shut the worker down between events, so storage is the source
// of truth.
chrome.storage.local.get(["sessionId", "dashboardOrigin"]).then((s) => {
  if (s.sessionId) state.sessionId = s.sessionId;
  if (s.dashboardOrigin) state.dashboardOrigin = s.dashboardOrigin;
});

// Pick up the session id when a dashboard tab first opens with the
// recording fragment. The launcher in lib/recording-launcher.ts
// appends #recording=<sessionId> to the initial URL.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  try {
    const u = new URL(details.url);
    const m = /(?:^|&)recording=([0-9a-f-]{36})/.exec(
      u.hash.replace(/^#/, ""),
    );
    if (!m) return;
    state.sessionId = m[1];
    state.dashboardOrigin = u.origin;
    void chrome.storage.local.set({
      sessionId: state.sessionId,
      dashboardOrigin: state.dashboardOrigin,
    });
  } catch {
    /* malformed URL — ignore */
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === "events" && Array.isArray(msg.events)) {
    for (const ev of msg.events) queue.push(ev);
    sendResponse({ queued: msg.events.length });
    void scheduleFlush();
    return true;
  }
  if (msg && msg.kind === "ping") {
    sendResponse({ active: state.sessionId != null });
    return true;
  }
  // ---- Popup ↔ worker control plane --------------------------------
  // The popup uses these to show status, set the dashboard origin
  // (when the recorder hook hasn't fired yet), pick the driver tab,
  // and force-reconnect the bridge WS.
  if (msg && msg.kind === "driver/status") {
    void (async () => {
      const tabId = await getActiveDriverTab();
      sendResponse({
        dashboardOrigin: state.dashboardOrigin,
        driverTabId: tabId,
        bridgeConnected: bridge.ws && bridge.ws.readyState === 1,
        bridgeLastError: bridge.lastError,
      });
    })();
    return true;
  }
  if (msg && msg.kind === "driver/setOrigin" && typeof msg.origin === "string") {
    state.dashboardOrigin = msg.origin.replace(/\/$/, "");
    void chrome.storage.local.set({ dashboardOrigin: state.dashboardOrigin });
    void connectBridge(); // reconnect against the new origin
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.kind === "driver/setDriverTab") {
    void (async () => {
      let tabId = msg.tabId;
      if (typeof tabId !== "number" && sender && sender.tab && sender.tab.id) {
        tabId = sender.tab.id;
      }
      if (typeof tabId !== "number") {
        // Fall back to the active tab in the focused window.
        const [active] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        tabId = active && active.id;
      }
      if (typeof tabId === "number") {
        await setActiveDriverTab(tabId);
        sendResponse({ ok: true, tabId });
      } else {
        sendResponse({ ok: false, error: "no tab" });
      }
    })();
    return true;
  }
  if (msg && msg.kind === "driver/reconnect") {
    void connectBridge();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// =====================================================================
// Driver bridge — WebSocket to /api/ext-bridge
// =====================================================================
//
// One persistent WS per worker lifetime. MV3 service workers can be
// recycled; we re-open on demand whenever a popup pings or the worker
// boots after dashboardOrigin is known. Backoff caps at 30 s to avoid
// hammering the dashboard during outages.

const bridge = {
  ws: null,
  reconnectTimer: null,
  reconnectDelayMs: 1000,
  lastError: null,
  /** Have we been told to stop reconnecting (e.g. dashboardOrigin
   *  cleared)? Set by disconnectBridge(). */
  shouldRun: true,
};

function bridgeUrl(origin, sessionCookie) {
  const u = new URL(origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/api/ext-bridge";
  u.search = sessionCookie ? `?session=${encodeURIComponent(sessionCookie)}` : "";
  u.hash = "";
  return u.toString();
}

async function getSessionCookie(origin) {
  try {
    const u = new URL(origin);
    const cookie = await chrome.cookies.get({ url: origin, name: "amaso_session" });
    return cookie ? cookie.value : null;
  } catch {
    return null;
  }
}

async function connectBridge() {
  if (!state.dashboardOrigin) {
    bridge.lastError =
      "no dashboardOrigin set — open the dashboard or use the popup";
    return;
  }
  bridge.shouldRun = true;
  // Tear down any existing socket cleanly.
  if (bridge.ws) {
    try {
      bridge.ws.close();
    } catch {
      /* ignore */
    }
    bridge.ws = null;
  }
  if (bridge.reconnectTimer) {
    clearTimeout(bridge.reconnectTimer);
    bridge.reconnectTimer = null;
  }
  // Read the signed amaso_session cookie out of the user's Chrome
  // profile and append it to the WebSocket URL as ?session=<value>.
  // Chrome MV3 service workers cannot attach Cookie headers to
  // WebSocket handshakes, so passing the value via the URL is the
  // only cross-host-safe way to authenticate the connection. The
  // server validates the HMAC signature on its end (lib/ext-bridge-ws,
  // which calls verifySigned), so the wire still carries an
  // unforgeable token.
  //
  // No-cookie path: log a warning and try to connect anyway. The
  // server will return 401 if it really needs auth and the popup
  // will surface "1006 closed without auth" so the user can debug
  // why the cookie isn't readable instead of the extension silently
  // never opening the socket.
  const sessionCookie = await getSessionCookie(state.dashboardOrigin);
  if (!sessionCookie) {
    console.warn(
      "[ext-bridge] no amaso_session cookie for",
      state.dashboardOrigin,
      ". connecting without auth so the close code surfaces clearly.",
    );
  }
  let url;
  try {
    url = bridgeUrl(state.dashboardOrigin, sessionCookie);
  } catch (err) {
    bridge.lastError = `bad dashboardOrigin: ${err && err.message}`;
    return;
  }
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    bridge.lastError = `WebSocket() threw: ${err && err.message}`;
    scheduleBridgeReconnect();
    return;
  }
  bridge.ws = ws;
  ws.onopen = () => {
    bridge.lastError = null;
    bridge.reconnectDelayMs = 1000;
    console.log("[ext-bridge] connected to", url);
  };
  ws.onmessage = (ev) => {
    void handleBridgeMessage(ev.data);
  };
  ws.onerror = (ev) => {
    // The Event isn't very informative in extension WSs; the close
    // event that follows usually has the real reason.
    bridge.lastError = "WebSocket error (see chrome://extensions logs)";
    console.warn("[ext-bridge] error", ev);
  };
  ws.onclose = (ev) => {
    if (bridge.ws === ws) bridge.ws = null;
    bridge.lastError = `closed (${ev.code} ${ev.reason || "no reason"})`;
    console.log("[ext-bridge] closed", ev.code, ev.reason);
    if (bridge.shouldRun) scheduleBridgeReconnect();
  };
}

function scheduleBridgeReconnect() {
  if (!bridge.shouldRun) return;
  if (bridge.reconnectTimer) return;
  const delay = bridge.reconnectDelayMs;
  bridge.reconnectTimer = setTimeout(() => {
    bridge.reconnectTimer = null;
    bridge.reconnectDelayMs = Math.min(30_000, bridge.reconnectDelayMs * 2);
    void connectBridge();
  }, delay);
}

async function handleBridgeMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : await raw.text());
  } catch {
    return;
  }
  if (msg.type === "hello") {
    // No-op; we know who we are because we authed via cookie.
    return;
  }
  if (msg.type === "ping") {
    safeSend({ type: "pong", ts: msg.ts });
    return;
  }
  if (msg.type === "command") {
    const id = msg.id;
    const cmd = msg.command || {};
    try {
      const result = await runTool(cmd.tool, cmd.args || {});
      safeSend({ type: "ack", id, ok: true, result });
    } catch (err) {
      safeSend({
        type: "ack",
        id,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }
}

function safeSend(obj) {
  if (!bridge.ws || bridge.ws.readyState !== 1) return;
  try {
    bridge.ws.send(JSON.stringify(obj));
  } catch (err) {
    console.warn("[ext-bridge] send failed", err);
  }
}

// Kick off the bridge as soon as we know the dashboardOrigin. The
// recorder hook (webNavigation listener above) writes it the first
// time the user opens the dashboard with #recording=<id>; the popup
// can also write it directly. We retry on a slow loop until it
// appears so a fresh install just needs the user to visit the
// dashboard once.
(async () => {
  // Wait for hydration of `state` from storage above to finish; the
  // existing chrome.storage.local.get(...).then(...) doesn't expose a
  // promise to await on, so just poll briefly.
  for (let i = 0; i < 50 && !state.dashboardOrigin; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (state.dashboardOrigin) {
    void connectBridge();
  }
})();

async function scheduleFlush() {
  if (flushing) return;
  flushing = true;
  try {
    await new Promise((r) => setTimeout(r, FLUSH_INTERVAL_MS));
    await flush();
  } finally {
    flushing = false;
    if (queue.length > 0) void scheduleFlush();
  }
}

async function flush() {
  if (queue.length === 0) return;
  if (!state.sessionId || !state.dashboardOrigin) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    const res = await fetch(
      `${state.dashboardOrigin}/api/recording/sessions/${state.sessionId}/events`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
      },
    );
    if (!res.ok) {
      // Re-queue the batch; we'll retry on the next flush tick.
      // 401/404 likely means the session was ended or auth lapsed; in
      // that case dropping is the right call to avoid an infinite
      // retry storm.
      if (res.status !== 401 && res.status !== 404) {
        queue.unshift(...batch);
      }
    }
  } catch {
    queue.unshift(...batch);
  }
}
