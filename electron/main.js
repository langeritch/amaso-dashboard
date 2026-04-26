// Amaso Companion — macOS menu-bar agent.
//
// THIS IS NOT A DASHBOARD. The dashboard is the PWA. The companion is a
// tiny, resident helper that lives in the macOS menu bar and exists only
// to run things the cloud dashboard can't do from a browser: local shell
// commands, filesystem access, system audio ducking, and so on.
//
// Architecture:
//   - No dock icon (`app.dock.hide()`).
//   - A Tray in the menu bar is the app's entire UI surface.
//   - Clicking the tray toggles a small frameless popover window. First run
//     the popover shows a login form; after login it shows a compact status
//     panel (connection, account, quit).
//   - Once authenticated, the companion opens a long-lived WebSocket back
//     to the dashboard and handles inbound command messages.
//
// Everything below is a working skeleton — real command dispatch and
// credential storage are left as TODOs with clear hooks.

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  safeStorage,
  session: electronSession,
  shell,
  systemPreferences,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { autoUpdater } = require("electron-updater");
const { duckOthers, restoreOthers } = require("./audio-duck");

// Dashboard the companion talks to. Override per-user via AMASO_URL for
// dev/staging — the companion is platform-agnostic about the origin.
const DASHBOARD_URL = process.env.AMASO_URL || "https://dashboard.amaso.nl";
const UPDATE_INTERVAL_MS = 30 * 60 * 1000;

let tray = null;
let popover = null;
let session = null; // { cookie, email } once authenticated
let vadWindow = null;
let duckingEnabled = true; // persisted across launches via settings.json
let vadStatus = "idle"; // "idle" | "listening" | "denied" | "error"
let trayIcons = null; // { disconnected, connected, thinking } nativeImages
let thinkingCount = 0; // commands currently in-flight — drives the tray badge

// ---- App lifecycle -------------------------------------------------------

// Only one companion instance at a time — a second launch just reveals the
// existing tray's popover.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => togglePopover());
}

app.whenReady().then(() => {
  // Menu-bar app posture: no dock icon, no app menu bar at the top.
  if (process.platform === "darwin") app.dock?.hide();

  duckingEnabled = loadSetting("duckingEnabled", true);
  // Launch-at-login defaults to true — the companion's whole job is to be
  // reachable from the dashboard without the user having to remember to
  // open it. Persisted in settings.json so the user's choice survives an
  // upgrade. We re-apply the setting on every boot rather than only on
  // first run so a manual change in System Settings → Login Items
  // doesn't drift permanently away from what the user toggled in our UI.
  applyLaunchAtLoginSetting();

  // Auto-grant the mic permission for our own hidden VAD window. We are
  // the only renderer in this app, so this is scoped to the embedded
  // VAD page — no third-party content ever runs in Electron here.
  electronSession.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => callback(permission === "media"),
  );

  createTray();
  wireAutoUpdater();
  if (duckingEnabled) startVad();
  session = loadStoredSession();
  if (session) connectToCloud();
});

function applyLaunchAtLoginSetting() {
  const want = loadSetting("launchAtLogin", true);
  // setLoginItemSettings is supported on macOS and Windows; on Linux
  // Electron returns silently. `openAsHidden` keeps the app from
  // flashing a window on login since we only ever show a popover.
  try {
    app.setLoginItemSettings({ openAtLogin: !!want, openAsHidden: true });
  } catch (err) {
    console.warn("[amaso-companion] setLoginItemSettings failed:", err?.message || err);
  }
}

function getLaunchAtLogin() {
  // Read the OS-level state (which is what actually drives login boot)
  // rather than just the persisted setting, so the popover toggle
  // reflects truth even if the user changed it in System Settings.
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return !!loadSetting("launchAtLogin", true);
  }
}

function setLaunchAtLogin(next) {
  const want = !!next;
  saveSetting("launchAtLogin", want);
  try {
    app.setLoginItemSettings({ openAtLogin: want, openAsHidden: true });
  } catch (err) {
    console.warn("[amaso-companion] setLoginItemSettings failed:", err?.message || err);
  }
  pushPopoverStatus();
}

// Quitting from the tray menu is the only "normal" exit — closing windows
// does not quit because there is no main window.
app.on("window-all-closed", (e) => {
  e.preventDefault?.();
});

app.on("before-quit", () => {
  // Best-effort restore so we don't leave other apps turned down if we
  // crash mid-duck.
  restoreOthers().catch(() => {});
});

// ---- Tray ---------------------------------------------------------------

function createTray() {
  // macOS convention: an icon whose filename ends in "Template" is treated
  // as a template image and auto-inverts for light/dark menu bars.
  // `scripts/generate-tray-icons.mjs` produces all three variants at 22x22
  // and @2x 44x44. Electron auto-picks the @2x file when it's next to the
  // 1x one, so we only pass the 1x path to createFromPath.
  const load = (name) => {
    const img = nativeImage.createFromPath(path.join(__dirname, "assets", `${name}.png`));
    return img.isEmpty() ? null : img;
  };
  const fallback = nativeImage.createEmpty();
  const disconnected = load("trayIconTemplate") || fallback;
  const connected = load("trayIconConnectedTemplate") || disconnected;
  const thinking = load("trayIconThinkingTemplate") || connected;
  trayIcons = { disconnected, connected, thinking };

  tray = new Tray(trayIcons.disconnected);
  tray.setToolTip("Amaso Companion");
  refreshTrayIcon();

  tray.on("click", () => togglePopover());
  tray.on("right-click", () => tray.popUpContextMenu(buildContextMenu()));
}

function refreshTrayIcon() {
  if (!tray || tray.isDestroyed?.() || !trayIcons) return;
  let next;
  if (!session) next = trayIcons.disconnected;
  else if (thinkingCount > 0) next = trayIcons.thinking;
  else if (wsStatus === "open") next = trayIcons.connected;
  else next = trayIcons.disconnected;
  try {
    tray.setImage(next);
    tray.setToolTip(`Amaso Companion — ${cloudLabel()}`);
  } catch {
    /* ignore — tray might be disposing */
  }
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: session ? `Signed in as ${session.email}` : "Not signed in",
      enabled: false,
    },
    {
      label: `    Cloud: ${cloudLabel()}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Mute others while I'm talking",
      type: "checkbox",
      checked: duckingEnabled,
      click: (item) => toggleDucking(item.checked),
    },
    {
      label: vadLabel(),
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Open dashboard",
      click: () => shell.openExternal(DASHBOARD_URL),
    },
    // Reconnect surfaces only when the dashboard isn't currently
    // reachable — when we're "open" the button would be a no-op and
    // misleading. "auth_failed" is also excluded because reconnecting
    // with a stale cookie would just close 4401 again.
    ...(session && wsStatus !== "open" && wsStatus !== "auth_failed"
      ? [{
          label: "Reconnect now",
          click: () => {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
            wsReconnectAttempt = 0;
            wsStopped = false;
            connectToCloud();
          },
        }]
      : []),
    session
      ? { label: "Sign out", click: signOut }
      : { label: "Sign in…", click: () => togglePopover(true) },
    { type: "separator" },
    {
      label: "Launch at login",
      type: "checkbox",
      checked: getLaunchAtLogin(),
      click: (item) => setLaunchAtLogin(item.checked),
    },
    { type: "separator" },
    { label: "Check for updates", click: () => autoUpdater.checkForUpdates().catch(() => {}) },
    { label: "Quit Amaso Companion", click: () => app.quit() },
  ]);
}

function cloudLabel() {
  if (!session) return "signed out";
  switch (wsStatus) {
    case "open":
      return "connected";
    case "connecting":
      return "connecting…";
    case "auth_failed":
      return "auth failed";
    default:
      return "offline — reconnecting";
  }
}

function vadLabel() {
  if (!duckingEnabled) return "    Off";
  switch (vadStatus) {
    case "listening":
      return "    Listening to mic";
    case "denied":
      return "    Mic access denied — open System Settings → Privacy";
    case "error":
      return "    Mic unavailable";
    default:
      return "    Starting mic…";
  }
}

// ---- Popover window ------------------------------------------------------

function togglePopover(forceOpen = false) {
  if (popover && !popover.isDestroyed()) {
    if (popover.isVisible() && !forceOpen) {
      popover.hide();
      return;
    }
    positionPopover();
    popover.show();
    popover.focus();
    return;
  }
  popover = new BrowserWindow({
    width: 320,
    height: 400,
    frame: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#0b0d10",
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  popover.setWindowButtonVisibility?.(false);

  // Lose focus → hide, like a real menu-bar popover.
  popover.on("blur", () => {
    if (!popover?.webContents.isDevToolsOpened()) popover?.hide();
  });

  popover.loadFile(path.join(__dirname, "login.html"));
  popover.once("ready-to-show", () => {
    positionPopover();
    popover.show();
    popover.focus();
  });
}

function positionPopover() {
  if (!popover || !tray) return;
  const trayBounds = tray.getBounds();
  const winBounds = popover.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });
  // Center horizontally under the tray icon; clamp to the current display.
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  x = Math.max(display.workArea.x + 8, Math.min(display.workArea.x + display.workArea.width - winBounds.width - 8, x));
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  popover.setPosition(x, y, false);
}

// ---- IPC from the login popover -----------------------------------------

ipcMain.handle("amaso:login", async (_evt, { email, password }) => {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body?.error || `http_${res.status}` };
    }
    const setCookie = res.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0] || "";
    session = { email, cookie };
    storeSession(session);
    connectToCloud();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// Snapshot of every field the popover renders. Both the IPC handler
// (initial pull on render) and the push function (live updates) call
// this — having one source of truth means a new field shows up in
// both paths automatically.
function buildStatusSnapshot() {
  return {
    dashboardUrl: DASHBOARD_URL,
    session: session ? { email: session.email } : null,
    wsStatus, // "disconnected" | "connecting" | "open" | "auth_failed"
    vadStatus, // "idle" | "listening" | "denied" | "error"
    duckingEnabled,
    launchAtLogin: getLaunchAtLogin(),
    thinking: thinkingCount > 0,
  };
}

ipcMain.handle("amaso:status", () => buildStatusSnapshot());

ipcMain.handle("amaso:signout", () => {
  signOut();
  return { ok: true };
});

// Quick actions surfaced in the popover. All return synchronously
// with a small ok/result payload so the renderer can disable the
// button mid-action and re-enable on resolve.
ipcMain.handle("amaso:openDashboard", () => {
  shell.openExternal(DASHBOARD_URL).catch(() => {});
  return { ok: true };
});

ipcMain.handle("amaso:reconnect", () => {
  // Manual reconnect: cancel the back-off timer and try right now. If
  // we're currently connected this is a no-op (connectToCloud guards
  // against double-open), but the user clicking the button while
  // online would be confusing UX — the button is hidden in the
  // renderer when wsStatus === "open".
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  wsReconnectAttempt = 0;
  wsStopped = false;
  connectToCloud();
  return { ok: true, wsStatus };
});

ipcMain.handle("amaso:setLaunchAtLogin", (_evt, next) => {
  setLaunchAtLogin(next);
  return { ok: true, launchAtLogin: getLaunchAtLogin() };
});

ipcMain.handle("amaso:setDucking", (_evt, next) => {
  toggleDucking(!!next);
  return { ok: true, duckingEnabled };
});

// Push status to the popover renderer whenever something changes
// (ws state, vad state, ducking, login items). The popover subscribes
// in preload via ipcRenderer.on; if it isn't open yet, the message is
// just dropped — the renderer pulls a fresh snapshot on its own
// `ready-to-show` cycle anyway.
function pushPopoverStatus() {
  if (!popover || popover.isDestroyed()) return;
  try {
    popover.webContents.send("amaso:status:update", buildStatusSnapshot());
  } catch {
    /* ignore — race with destroy */
  }
}

// ---- Cloud command channel ----------------------------------------------
//
// One WebSocket per signed-in session, speaking the schema defined in
// dashboard `lib/companion-ws.ts`. The dashboard addresses commands to
// *this user's* companion; we dispatch through `dispatchCommand()` and
// ack success/failure synchronously. We also stream local VAD events
// back as `{type: "event", ...}` so the dashboard knows when the user
// is mid-sentence.
//
// Reconnect policy:
//   - Backoff 1 s → 2 → 4 → 8 → 16 → 30 s (capped), full jitter.
//   - On graceful 4401 (bad session) we stop retrying and clear the
//     stored session — the user has to sign in again. Any other
//     disconnect keeps reconnecting forever.
//   - Ping/pong: the dashboard pings every 20 s. If we haven't seen a
//     ping in 45 s we self-terminate the socket so the backoff loop
//     kicks in. Covers proxies that don't forward close frames.

const WebSocket = require("ws");

const WS_URL = DASHBOARD_URL.replace(/^http/, "ws") + "/api/companion";
const WS_RECONNECT_MIN_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;
const WS_SERVER_PING_GRACE_MS = 45_000;

let socket = null;
let wsReconnectAttempt = 0;
let wsReconnectTimer = null;
let wsSilenceTimer = null;
let wsStopped = false;
let wsStatus = "disconnected"; // "disconnected" | "connecting" | "open" | "auth_failed"

// Outgoing buffer for acks + events that couldn't ship because the
// socket wasn't OPEN at the moment of write. This is the COMPANION
// side of the offline-resilient pipe: a command can finish executing
// (shell.exec returns 200ms after the dashboard pushed the message)
// while the WS is briefly down between dispatch and ack. Without
// this buffer the dashboard would only ever see the COMMAND_TIMEOUT
// path even though the work succeeded. On the open edge we drain
// the buffer FIRST, so the dashboard's ack handlers fire before any
// freshly-queued commands arrive.
//
// Bounded so a chronically-offline companion can't OOM. 200 entries
// is generous — a one-minute hiccup with a command every 100 ms
// fits with room to spare; longer outages are better solved by
// dropping the oldest events than crashing the renderer.
const OUTBOX_MAX = 200;
const outbox = [];

function outboxPush(msg) {
  if (outbox.length >= OUTBOX_MAX) outbox.shift();
  outbox.push(msg);
}

function outboxFlush(ws) {
  while (outbox.length > 0 && ws.readyState === WebSocket.OPEN) {
    const next = outbox.shift();
    try {
      ws.send(JSON.stringify(next));
    } catch (err) {
      // Send failed — re-queue at the head and bail; the next open
      // edge will retry. shift() already removed it so put it back.
      outbox.unshift(next);
      console.warn("[amaso-companion-ws] outbox flush stalled:", err?.message || err);
      return;
    }
  }
}

function connectToCloud() {
  if (!session?.cookie) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  wsStopped = false;
  wsStatus = "connecting";
  refreshTrayMenu();
  pushPopoverStatus();

  let ws;
  try {
    ws = new WebSocket(WS_URL, {
      headers: {
        cookie: session.cookie,
        "user-agent": "Amaso Companion",
      },
      // The dashboard is typically behind a Cloudflare tunnel or a
      // localhost dev server; 10 s is plenty for either.
      handshakeTimeout: 10_000,
    });
  } catch (err) {
    console.warn("[amaso-companion-ws] create failed:", err?.message || err);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.on("open", () => {
    wsReconnectAttempt = 0;
    wsStatus = "open";
    refreshTrayMenu();
    pushPopoverStatus();
    armSilenceTimer();
    // Drain the outbox immediately so any acks/events from
    // pre-disconnect work land before the dashboard re-flushes its
    // own offline queue back at us. Order matters: dashboard expects
    // the ack for the original command id BEFORE seeing a fresh
    // command with the same id (replay).
    outboxFlush(ws);
    console.log(
      `[amaso-companion-ws] connected${outbox.length ? ` (outbox still has ${outbox.length})` : ""}`,
    );
  });

  ws.on("message", async (raw) => {
    armSilenceTimer();
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "ping") {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }
      return;
    }
    if (msg.type === "hello") {
      console.log(`[amaso-companion-ws] hello ${msg.user?.name} (${msg.user?.id})`);
      // Seed the dashboard with current VAD status so its UI reflects
      // the companion's state without waiting for the first transition.
      sendEvent("status", { vadEnabled: duckingEnabled, vadStatus });
      return;
    }
    if (msg.type === "command" && msg.id) {
      thinkingCount += 1;
      refreshTrayIcon();
      let ok = true;
      let error;
      let result;
      try {
        result = await dispatchCommand(msg.command);
      } catch (err) {
        ok = false;
        error = String(err?.message || err);
      } finally {
        thinkingCount = Math.max(0, thinkingCount - 1);
        refreshTrayIcon();
      }
      // Route through the outbox unconditionally: if the socket is
      // open the ack ships immediately, if it dropped between
      // dispatch start and now the ack waits for the next reconnect.
      // Without this fallback the dashboard would only see the
      // 10 s COMMAND_TIMEOUT path on every brief disconnect, even
      // though the work actually completed.
      sendAck({ id: msg.id, ok, error, result });
      return;
    }
  });

  ws.on("close", (code, reason) => {
    clearTimeout(wsSilenceTimer);
    wsSilenceTimer = null;
    if (socket === ws) socket = null;
    const reasonText = reason?.toString?.() || "";
    // 4401 is our dashboard's "bad session" close code.
    if (code === 4401) {
      console.warn("[amaso-companion-ws] auth failed; clearing session");
      wsStatus = "auth_failed";
      wsStopped = true;
      refreshTrayMenu();
      pushPopoverStatus();
      signOut();
      return;
    }
    wsStatus = "disconnected";
    refreshTrayMenu();
    pushPopoverStatus();
    console.log(`[amaso-companion-ws] closed code=${code} reason=${reasonText}`);
    if (!wsStopped) scheduleReconnect();
  });

  ws.on("error", (err) => {
    // Don't trigger a reconnect here — `close` always follows `error`
    // on node-ws, and scheduling twice would halve our backoff.
    console.warn("[amaso-companion-ws] error:", err?.message || err);
  });
}

function scheduleReconnect() {
  if (wsStopped) return;
  if (wsReconnectTimer) return;
  const base = Math.min(
    WS_RECONNECT_MAX_MS,
    WS_RECONNECT_MIN_MS * 2 ** wsReconnectAttempt,
  );
  const delay = Math.floor(Math.random() * base);
  wsReconnectAttempt += 1;
  console.log(`[amaso-companion-ws] reconnect in ${Math.round(delay / 100) / 10}s`);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectToCloud();
  }, delay);
}

function armSilenceTimer() {
  clearTimeout(wsSilenceTimer);
  wsSilenceTimer = setTimeout(() => {
    // No ping from the dashboard in too long — pull the plug and let
    // the close handler restart us.
    console.warn("[amaso-companion-ws] server silence — cycling socket");
    try {
      socket?.terminate?.();
    } catch {
      /* ignore */
    }
  }, WS_SERVER_PING_GRACE_MS);
}

function disconnectFromCloud() {
  wsStopped = true;
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  clearTimeout(wsSilenceTimer);
  wsSilenceTimer = null;
  try {
    socket?.close?.(1000, "signing out");
  } catch {
    /* ignore */
  }
  socket = null;
  wsStatus = "disconnected";
}

function sendEvent(name, data) {
  const msg = { type: "event", event: name, data };
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(msg));
      return;
    } catch {
      /* connection died between readyState check and send — fall
         through to outbox so we don't drop the event silently */
    }
  }
  outboxPush(msg);
}

/** Send a command ack via the outbox so a brief disconnect between
 *  command dispatch and completion doesn't lose the result. The
 *  dashboard's pending Map is keyed on `id` and will reconcile when
 *  the ack lands, even if the reconciliation happens after a
 *  reconnect; if the dashboard already gave up (COMMAND_TIMEOUT) the
 *  late ack is harmlessly ignored. */
function sendAck(ack) {
  const msg = { type: "ack", ...ack };
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(msg));
      return;
    } catch {
      /* fall through to outbox */
    }
  }
  outboxPush(msg);
}

// Hard limits for local-action commands. The companion runs as the
// signed-in user, so a runaway dashboard call could in principle fill
// memory or hang forever. These bounds keep that bounded without
// blocking realistic use.
const SHELL_TIMEOUT_MS = 30_000;
const SHELL_MAX_OUTPUT_BYTES = 1_000_000; // 1 MB per stream
const FS_READ_MAX_BYTES = 10_000_000; // 10 MB

async function dispatchCommand(msg) {
  switch (msg?.type) {
    case "audio.duck":
      await duckOthers(typeof msg.level === "number" ? msg.level : 0.25);
      return { level: msg.level ?? 0.25 };
    case "audio.restore":
      await restoreOthers();
      return { restored: true };
    case "shell.exec":
      return runShell(msg);
    case "fs.read":
      return readFile(msg);
    default:
      throw new Error(`unknown command: ${msg?.type || "?"}`);
  }
}

function runShell(msg) {
  const cmd = typeof msg?.cmd === "string" ? msg.cmd : "";
  if (!cmd.trim()) throw new Error("shell.exec: empty cmd");
  const cwd = expandHome(typeof msg?.cwd === "string" ? msg.cwd : os.homedir());

  // Use a login shell so PATH and shell aliases match what the user sees
  // in their terminal. macOS default is zsh; honor $SHELL when set.
  const shellPath = process.env.SHELL || "/bin/zsh";

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const child = spawn(shellPath, ["-l", "-c", cmd], {
      cwd,
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        stdoutTruncated,
        stderrTruncated,
      });
    }, SHELL_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (stdout.length + text.length > SHELL_MAX_OUTPUT_BYTES) {
        stdout = (stdout + text).slice(0, SHELL_MAX_OUTPUT_BYTES);
        stdoutTruncated = true;
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (stderr.length + text.length > SHELL_MAX_OUTPUT_BYTES) {
        stderr = (stderr + text).slice(0, SHELL_MAX_OUTPUT_BYTES);
        stderrTruncated = true;
        return;
      }
      stderr += text;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + String(err?.message || err),
        exitCode: null,
        signal: null,
        timedOut: false,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: signal || null,
        timedOut: false,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

async function readFile(msg) {
  const target = typeof msg?.path === "string" ? msg.path : "";
  if (!target) throw new Error("fs.read: empty path");
  const resolved = expandHome(target);

  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error(`fs.read: not a file: ${resolved}`);
  const truncated = stat.size > FS_READ_MAX_BYTES;
  const bytesToRead = truncated ? FS_READ_MAX_BYTES : stat.size;

  const fh = await fsp.open(resolved, "r");
  try {
    const buf = Buffer.alloc(bytesToRead);
    if (bytesToRead > 0) await fh.read(buf, 0, bytesToRead, 0);
    return {
      path: resolved,
      size: stat.size,
      bytesRead: bytesToRead,
      truncated,
      content: buf.toString("utf8"),
    };
  } finally {
    await fh.close();
  }
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = { dispatchCommand, sendEvent };

// ---- Mic-aware system ducking -------------------------------------------
//
// A hidden BrowserWindow runs a basic RMS voice-activity detector on the
// default input device. When speech starts, we lower everyone else's audio;
// when the user stops talking (plus a short hang), we restore. The "mic is
// open" case falls out naturally: if Spar (or any app sharing the default
// input) is listening, our hidden window is also listening and will duck on
// the same voice energy.
//
// This runs entirely locally — no dashboard round-trip, no auth required.
// The tray menu has a single toggle to disable it.

function startVad() {
  if (vadWindow && !vadWindow.isDestroyed()) return;

  // On macOS, querying the status up front lets us surface "denied" in the
  // tray menu without waiting for a getUserMedia rejection.
  if (process.platform === "darwin" && systemPreferences?.getMediaAccessStatus) {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    if (status === "denied") {
      vadStatus = "denied";
      refreshTrayMenu();
      return;
    }
  }

  vadWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    frame: false,
    width: 1,
    height: 1,
    webPreferences: {
      preload: path.join(__dirname, "vad-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The VAD renderer loads vad.html with no network access; it only
      // touches the mic and posts RMS state back via IPC.
    },
  });

  vadWindow.on("closed", () => {
    vadWindow = null;
  });

  vadWindow.loadFile(path.join(__dirname, "vad.html")).catch(() => {
    vadStatus = "error";
    refreshTrayMenu();
  });
}

function stopVad() {
  if (vadWindow && !vadWindow.isDestroyed()) {
    vadWindow.destroy();
  }
  vadWindow = null;
  vadStatus = "idle";
  // If we were mid-duck when the user flipped the switch, put things back.
  restoreOthers().catch(() => {});
}

function toggleDucking(next) {
  duckingEnabled = Boolean(next);
  saveSetting("duckingEnabled", duckingEnabled);
  if (duckingEnabled) startVad();
  else stopVad();
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed?.()) return;
  // macOS shows the last-built right-click menu; rebuild on state change
  // so the "Listening…" / "Denied" sub-label reflects reality.
  try {
    tray.setContextMenu(buildContextMenu());
  } catch {
    /* ignore — we'll rebuild on the next right-click */
  }
  refreshTrayIcon();
  // Refreshing the tray and the popover always go together — anything
  // that affects the right-click menu's status row affects the popover
  // too. Coalescing here saves touching every toggleDucking / vad /
  // signOut call site.
  pushPopoverStatus();
}

ipcMain.on("amaso:vad:state", (_evt, state) => {
  if (!duckingEnabled) return;
  if (vadStatus !== "listening") {
    vadStatus = "listening";
    refreshTrayMenu();
  }
  if (state && state.speaking) {
    duckOthers(0.25).catch(() => {});
    sendEvent("vad:speaking", { rms: state.rms });
  } else {
    restoreOthers().catch(() => {});
    sendEvent("vad:silent", { rms: state?.rms });
  }
});

ipcMain.on("amaso:vad:error", (_evt, msg) => {
  // Chromium reports mic denial as NotAllowedError; anything else is a
  // "something went wrong" case we can't do much about.
  const text = String(msg || "");
  vadStatus = /NotAllowed|Permission/i.test(text) ? "denied" : "error";
  refreshTrayMenu();
});

// ---- Settings persistence (local, unencrypted) --------------------------
//
// Companion-level preferences that aren't credentials. Stored next to the
// session file so one directory fully owns the app's state.

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSetting(key, fallback) {
  try {
    if (!fs.existsSync(settingsFile())) return fallback;
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    let current = {};
    if (fs.existsSync(settingsFile())) {
      try {
        current = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) || {};
      } catch {
        current = {};
      }
    }
    current[key] = value;
    fs.writeFileSync(settingsFile(), JSON.stringify(current));
  } catch {
    /* best-effort */
  }
}

// ---- Session persistence ------------------------------------------------

function sessionFile() {
  return path.join(app.getPath("userData"), "session.bin");
}

function storeSession(s) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(JSON.stringify(s));
      fs.writeFileSync(sessionFile(), encrypted);
    } else {
      // Keychain/DPAPI not available — skip persistence rather than write
      // plaintext credentials to disk.
    }
  } catch {
    /* best-effort */
  }
}

function loadStoredSession() {
  try {
    if (!fs.existsSync(sessionFile())) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const buf = fs.readFileSync(sessionFile());
    return JSON.parse(safeStorage.decryptString(buf));
  } catch {
    return null;
  }
}

function signOut() {
  try {
    fs.unlinkSync(sessionFile());
  } catch {
    /* already gone */
  }
  session = null;
  disconnectFromCloud();
  if (popover && !popover.isDestroyed()) popover.reload();
}

// ---- Auto-update --------------------------------------------------------

function wireAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (err) => {
    console.warn("[amaso-companion-updater]", err?.message || err);
  });
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  check();
  setInterval(check, UPDATE_INTERVAL_MS);
}
