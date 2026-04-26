"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Keyboard,
  Plus,
  RotateCw,
  Square as StopIcon,
  X,
} from "lucide-react";
import AutomationsList from "./AutomationsList";

// Wire types must match lib/browser-ws.ts. Kept inline (small surface,
// no external consumers) but if a third caller appears, lift to types/.
type TabSummary = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
};
type ServerMsg =
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "navigation"; tabId: number; url: string; title: string }
  | { type: "tabs"; tabs: TabSummary[]; activeTabId: number }
  | { type: "ready"; width: number; height: number; recordingId: string | null }
  | { type: "session_ended"; recordingId: string | null }
  | { type: "error"; message: string };

// End-of-session modal state. Only used when this viewer was opened with
// a recordingId — plain-browser sessions skip the modal and just show
// "Stream closed".
//   idle        — no end has been triggered
//   modal       — modal is up, waiting for the user's choice
//   saving      — save + analyze in flight
//   discarding  — discard in flight
type EndingState = "idle" | "modal" | "saving" | "discarding";

const NATIVE_WIDTH = 1280;
const NATIVE_HEIGHT = 800;
// WebSocket reconnect backoff. Capped to keep the user from waiting
// forever after the laptop wakes from sleep with stale sockets.
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

// "connecting"   — socket is opening (initial attempt)
// "connected"    — socket is open but Chromium hasn't sent `ready` yet
// "ready"        — receiving frames
// "reconnecting" — socket dropped, backoff in progress
// "error"        — server sent a typed error message
// "closed"       — viewer was unmounted / user stopped
// "unreachable"  — exhausted reconnect budget without ever opening
type Status =
  | "connecting"
  | "connected"
  | "ready"
  | "reconnecting"
  | "error"
  | "closed"
  | "unreachable";

export default function BrowserViewer({
  recordingId,
}: {
  recordingId: string | null;
}) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hiddenInputRef = useRef<HTMLInputElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const hasEverConnectedRef = useRef(false);
  const stoppedRef = useRef(false);
  // Set the instant an end is triggered (locally or by `session_ended`
  // from the server). Blocks the reconnect loop so we don't silently
  // spin up a fresh Chromium after the user has asked to stop.
  const endingRef = useRef(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [currentUrl, setCurrentUrl] = useState("");
  const [addressBar, setAddressBar] = useState("");
  const [tabs, setTabs] = useState<TabSummary[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [endingState, setEndingState] = useState<EndingState>("idle");
  const [endName, setEndName] = useState("");
  const [endError, setEndError] = useState<string | null>(null);

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket closed mid-send — onclose handler will reconnect */
    }
  }, []);

  // Connection lifecycle: open + reconnect-on-close. Captured in a ref
  // so the same instance survives across renders without re-firing
  // useEffect's mount/unmount.
  useEffect(() => {
    stoppedRef.current = false;
    let timer: number | null = null;

    function connect() {
      if (stoppedRef.current) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const path = recordingId
        ? `/api/browser?recording=${encodeURIComponent(recordingId)}`
        : "/api/browser";
      const url = `${proto}//${location.host}${path}`;
      console.log("[BrowserViewer] connecting", { url });
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        console.error("[BrowserViewer] ws construction failed", err);
        // Construction can throw on bad URLs / blocked schemes — treat
        // identically to onclose so the backoff path runs.
        setStatus("error");
        setErrMsg(err instanceof Error ? err.message : "ws_construct_failed");
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      const drawState = { drawing: false, queued: null as string | null };
      function paint(base64: string) {
        if (drawState.drawing) {
          drawState.queued = base64;
          return;
        }
        drawState.drawing = true;
        const img = new Image();
        img.onload = () => {
          const c = canvasRef.current;
          if (c) {
            const ctx = c.getContext("2d");
            if (ctx) ctx.drawImage(img, 0, 0, c.width, c.height);
          }
          drawState.drawing = false;
          if (drawState.queued) {
            const next = drawState.queued;
            drawState.queued = null;
            paint(next);
          }
        };
        img.onerror = () => {
          drawState.drawing = false;
        };
        img.src = `data:image/jpeg;base64,${base64}`;
      }

      ws.onopen = () => {
        console.log("[BrowserViewer] ws open — waiting for server ready");
        hasEverConnectedRef.current = true;
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        setErrMsg(null);
        setStatus("connected");
      };
      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data) as ServerMsg;
        } catch {
          return;
        }
        switch (msg.type) {
          case "ready":
            console.log("[BrowserViewer] ready", {
              width: msg.width,
              height: msg.height,
              recordingId: msg.recordingId,
            });
            setStatus("ready");
            break;
          case "frame":
            paint(msg.data);
            break;
          case "navigation":
            console.log("[BrowserViewer] navigation", {
              tabId: msg.tabId,
              url: msg.url,
            });
            setCurrentUrl(msg.url);
            setAddressBar(msg.url);
            // Update the cached title for this tab so the tab strip stays
            // current without waiting for the next `tabs` broadcast.
            setTabs((prev) =>
              prev.map((t) =>
                t.tabId === msg.tabId
                  ? { ...t, url: msg.url, title: msg.title }
                  : t,
              ),
            );
            break;
          case "tabs":
            console.log("[BrowserViewer] tabs", {
              count: msg.tabs.length,
              activeTabId: msg.activeTabId,
            });
            setTabs(msg.tabs);
            setActiveTabId(msg.activeTabId);
            // Sync address bar to the active tab when the strip changes
            // (e.g. a switch initiated by another viewer of the same
            // session). Skip if the user is mid-edit.
            {
              const active = msg.tabs.find((t) => t.active);
              if (active && document.activeElement?.tagName !== "INPUT") {
                setCurrentUrl(active.url);
                setAddressBar(active.url);
              }
            }
            break;
          case "session_ended":
            console.log("[BrowserViewer] server signaled session_ended", {
              recordingId: msg.recordingId,
            });
            endingRef.current = true;
            // Only recording sessions get the save/discard modal. For
            // plain browser sessions, just settle into "closed" and
            // stop reconnecting.
            if (recordingId) {
              setEndingState((s) => (s === "idle" ? "modal" : s));
            } else {
              setStatus("closed");
            }
            break;
          case "error":
            console.error("[BrowserViewer] server error", msg.message);
            setStatus("error");
            setErrMsg(msg.message);
            break;
        }
      };
      ws.onerror = (ev) => {
        // The onclose handler runs right after; let it own the
        // reconnect/state update path so we don't double-handle. Log
        // here so the browser console shows the low-level failure even
        // when close codes are uninformative (1006 etc.).
        console.warn("[BrowserViewer] ws error", ev);
      };
      ws.onclose = (ev) => {
        console.log("[BrowserViewer] ws close", {
          code: ev.code,
          reason: ev.reason,
          wasClean: ev.wasClean,
          hadOpened: hasEverConnectedRef.current,
          ending: endingRef.current,
        });
        wsRef.current = null;
        if (stoppedRef.current || endingRef.current) {
          setStatus("closed");
          return;
        }
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (stoppedRef.current || endingRef.current) return;
      const attempt = reconnectAttemptRef.current;
      // Distinguish "flaky connection" from "server isn't there". If we
      // never got a single successful open and we've burned the full
      // backoff budget, treat it as unreachable and stop retrying — the
      // user should know to check the server/tunnel, not keep waiting.
      if (attempt >= MAX_RECONNECT_ATTEMPTS && !hasEverConnectedRef.current) {
        console.error(
          `[BrowserViewer] server unreachable after ${MAX_RECONNECT_ATTEMPTS} attempts`,
        );
        setStatus("unreachable");
        setErrMsg(
          `Could not reach the stream server after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
        );
        return;
      }
      const delay =
        RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttemptRef.current = attempt + 1;
      setReconnectAttempt(attempt + 1);
      setStatus("reconnecting");
      console.log(
        `[BrowserViewer] reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
      );
      timer = window.setTimeout(connect, delay);
    }

    connect();

    return () => {
      stoppedRef.current = true;
      if (timer) window.clearTimeout(timer);
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [recordingId]);

  // ─────────────────────── input forwarding ───────────────────────
  // Pointer Events unify mouse, pen, and touch — same code path runs
  // on desktop, iPad, and phone. We capture the pointer on down so a
  // drag that leaves the canvas still ends with an up event.

  function localToRemote(clientX: number, clientY: number) {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * NATIVE_WIDTH;
    const y = ((clientY - rect.top) / rect.height) * NATIVE_HEIGHT;
    return {
      x: Math.max(0, Math.min(NATIVE_WIDTH, Math.round(x))),
      y: Math.max(0, Math.min(NATIVE_HEIGHT, Math.round(y))),
    };
  }

  function buttonName(b: number): "left" | "right" | "middle" {
    if (b === 1) return "middle";
    if (b === 2) return "right";
    return "left";
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y } = localToRemote(e.clientX, e.clientY);
    send({ type: "mousemove", x, y });
  }
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Tap on the canvas focuses the hidden input so the soft keyboard
    // pops on mobile and physical-keyboard events have a focus target
    // on desktop.
    hiddenInputRef.current?.focus({ preventScroll: true });
    const { x, y } = localToRemote(e.clientX, e.clientY);
    send({ type: "mousedown", x, y, button: buttonName(e.button) });
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    const { x, y } = localToRemote(e.clientX, e.clientY);
    send({ type: "mouseup", x, y, button: buttonName(e.button) });
  }
  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    const { x, y } = localToRemote(e.clientX, e.clientY);
    send({ type: "wheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY });
  }
  function onContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
  }

  // The hidden input is the keyboard focus target for both desktop
  // and mobile. Single characters stream out via the `input` event
  // (the soft keyboard fires this on every tap); special keys go
  // through `keydown`/`keyup`. This sidesteps the desktop-only
  // window keydown listener that the previous version used (which
  // never fired on touch devices because soft keyboards don't
  // necessarily emit keydown events).
  function onHiddenInput(e: React.FormEvent<HTMLInputElement>) {
    const v = e.currentTarget.value;
    if (v) {
      send({ type: "type", text: v });
      e.currentTarget.value = "";
    }
  }
  function onHiddenKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Multi-char keys are intent (Enter, Backspace, arrows, F-keys).
    // Single-char keys are caught by the input event above; suppress
    // them here so we don't double-send the letter.
    if (e.key.length > 1) {
      e.preventDefault();
      send({ type: "keydown", key: e.key });
    }
  }
  function onHiddenKeyUp(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key.length > 1) {
      e.preventDefault();
      send({ type: "keyup", key: e.key });
    }
  }

  function navigate(e: React.FormEvent) {
    e.preventDefault();
    if (!addressBar.trim()) return;
    send({ type: "navigate", url: addressBar.trim() });
  }

  // ─────────────────── end-of-session actions ───────────────────
  // All three mark endingRef FIRST so the WS onclose that follows our
  // server-side teardown doesn't kick the reconnect loop. For recording
  // sessions the server also flips recording_sessions.status='ended'
  // via POST /end, so if the user later refreshes the page they don't
  // see this session as still active.

  const beginEnd = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    if (recordingId) {
      setEndingState("modal");
      setEndError(null);
      try {
        await fetch(`/api/recording/sessions/${recordingId}/end`, {
          method: "POST",
        });
      } catch {
        /* best-effort — server tears down either way when WS drops */
      }
    } else {
      // No recording: just stop the headless browser and show "closed".
      setStatus("closed");
      send({ type: "stop" });
    }
    const ws = wsRef.current;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }, [recordingId, send]);

  const saveAndAnalyze = useCallback(async () => {
    if (!recordingId) return;
    setEndingState("saving");
    setEndError(null);
    try {
      const patchRes = await fetch(`/api/recording/sessions/${recordingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: endName.trim() || null }),
      });
      if (!patchRes.ok) {
        throw new Error(`Could not save name (${patchRes.status})`);
      }
      const analyzeRes = await fetch(
        `/api/recording/sessions/${recordingId}/analyze`,
        { method: "POST" },
      );
      if (!analyzeRes.ok) {
        throw new Error(`Could not queue analysis (${analyzeRes.status})`);
      }
      router.push(`/recording/${recordingId}`);
    } catch (err) {
      setEndError(err instanceof Error ? err.message : "unknown_error");
      setEndingState("modal");
    }
  }, [recordingId, endName, router]);

  const discard = useCallback(async () => {
    if (!recordingId) return;
    setEndingState("discarding");
    setEndError(null);
    try {
      const res = await fetch(`/api/recording/sessions/${recordingId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`Could not discard (${res.status})`);
      }
      router.push("/recording");
    } catch (err) {
      setEndError(err instanceof Error ? err.message : "unknown_error");
      setEndingState("modal");
    }
  }, [recordingId, router]);

  const busyEnding =
    endingState === "saving" || endingState === "discarding";

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      {tabs.length > 0 && (
        <div className="thin-scroll flex flex-shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-neutral-800 bg-neutral-950 px-2 py-1.5">
          {tabs.map((t) => {
            const isActive = t.tabId === activeTabId;
            const display = t.title?.trim() || t.url || "New tab";
            return (
              <div
                key={t.tabId}
                className={`group flex max-w-[180px] flex-shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ${
                  isActive
                    ? "border-neutral-700 bg-neutral-900 text-neutral-100"
                    : "border-transparent bg-neutral-950 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                <button
                  type="button"
                  onClick={() => send({ type: "switch_tab", tabId: t.tabId })}
                  className="min-w-0 flex-1 truncate text-left"
                  title={`${t.title || t.url}\n${t.url}`}
                >
                  {display}
                </button>
                <button
                  type="button"
                  onClick={() => send({ type: "close_tab", tabId: t.tabId })}
                  className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200 ${
                    isActive ? "" : "opacity-0 group-hover:opacity-100"
                  }`}
                  aria-label={`Close ${display}`}
                  title="Close tab"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => send({ type: "new_tab" })}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            aria-label="New tab"
            title="New tab"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-neutral-800 px-2 py-2 sm:gap-2 sm:px-3">
        <button
          type="button"
          onClick={() => send({ type: "back" })}
          aria-label="Back"
          className="rounded p-2 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => send({ type: "forward" })}
          aria-label="Forward"
          className="rounded p-2 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => send({ type: "reload" })}
          aria-label="Reload"
          className="rounded p-2 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        >
          <RotateCw className="h-4 w-4" />
        </button>
        <form onSubmit={navigate} className="flex min-w-0 flex-1 items-center gap-1">
          <input
            value={addressBar}
            onChange={(e) => setAddressBar(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Enter a URL — e.g. example.com"
            aria-label="Address bar"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            inputMode="url"
            enterKeyHint="go"
            // `text-base` (16px) avoids iOS's "zoom on focus" behaviour
            // triggered by inputs with a font size below 16px. Taller
            // padding on mobile keeps the tap target above the 44px
            // accessibility minimum.
            className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-base text-neutral-200 focus:border-neutral-700 focus:outline-none sm:py-1 sm:text-sm"
          />
          <button
            type="submit"
            aria-label="Go"
            title="Navigate to the URL"
            className="rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm font-medium text-neutral-200 hover:border-neutral-700 hover:bg-neutral-900 sm:py-1"
          >
            Go
          </button>
        </form>
        <button
          type="button"
          onClick={() => hiddenInputRef.current?.focus({ preventScroll: true })}
          aria-label="Open keyboard"
          title="Tap to open the soft keyboard for the remote browser"
          className="rounded p-2 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 sm:hidden"
        >
          <Keyboard className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => void beginEnd()}
          disabled={endingRef.current}
          aria-label={recordingId ? "End recording" : "Stop browser"}
          title={
            recordingId
              ? "End this recording"
              : "Stop the remote browser"
          }
          className="rounded p-2 text-red-400 hover:bg-red-500/15 disabled:opacity-50"
        >
          <StopIcon className="h-4 w-4" />
        </button>
        <span
          className={`ml-1 hidden text-[10px] uppercase tracking-[0.18em] sm:inline ${
            status === "ready"
              ? "text-emerald-400"
              : status === "error" || status === "unreachable"
                ? "text-red-400"
                : status === "reconnecting"
                  ? "text-amber-400"
                  : status === "connected"
                    ? "text-sky-400"
                    : "text-neutral-500"
          }`}
        >
          {status}
        </span>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-auto bg-black p-1 sm:p-2">
        <div
          ref={wrapperRef}
          className="relative max-h-full max-w-full overflow-hidden rounded-md ring-1 ring-neutral-800"
          style={{ aspectRatio: `${NATIVE_WIDTH} / ${NATIVE_HEIGHT}` }}
        >
          <canvas
            ref={canvasRef}
            width={NATIVE_WIDTH}
            height={NATIVE_HEIGHT}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onContextMenu={onContextMenu}
            // touch-none disables the browser's native touch gestures
            // (scroll, pinch-zoom) on the canvas so our pointer events
            // get raw coordinates without page-level scrolling
            // hijacking them.
            className="h-full w-full cursor-pointer touch-none select-none bg-white"
          />
          {/* Off-screen but focusable. Positioned at the canvas's
              centre so iOS's "scroll into view on focus" doesn't
              jump the page when the soft keyboard opens. */}
          <input
            ref={hiddenInputRef}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-hidden="true"
            tabIndex={-1}
            onInput={onHiddenInput}
            onKeyDown={onHiddenKeyDown}
            onKeyUp={onHiddenKeyUp}
            className="pointer-events-none absolute left-1/2 top-1/2 h-px w-px -translate-x-1/2 -translate-y-1/2 opacity-0"
          />
          {status === "ready" &&
            (() => {
              const active = tabs.find((t) => t.tabId === activeTabId);
              const url = active?.url ?? currentUrl;
              const onLauncher = !url || url === "about:blank";
              if (!onLauncher) return null;
              return (
                <div className="thin-scroll absolute inset-0 overflow-auto bg-neutral-950 px-6 py-8 sm:px-10 sm:py-12">
                  <div className="mx-auto max-w-3xl">
                    <header className="mb-6">
                      <h1 className="text-xl font-semibold tracking-tight text-neutral-100 sm:text-2xl">
                        Automations
                      </h1>
                      <p className="mt-1 text-sm text-neutral-500">
                        Click ▶ to open in this tab. Use ⚙ to add or edit
                        shortcuts.
                      </p>
                    </header>
                    <AutomationsList
                      onLaunch={(a) => {
                        if (a.kind === "url") {
                          send({ type: "navigate", url: a.payload.url });
                          // Attribute the in-progress recording (if any)
                          // to this automation. First PATCH wins
                          // server-side, so re-launches don't reattribute.
                          if (recordingId) {
                            void fetch(
                              `/api/recording/sessions/${recordingId}`,
                              {
                                method: "PATCH",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ automationId: a.id }),
                              },
                            );
                          }
                        }
                      }}
                    />
                  </div>
                </div>
              );
            })()}
          {status !== "ready" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 px-4 text-center text-sm text-neutral-300">
              {status === "connecting" && "Connecting to stream server…"}
              {status === "connected" && "Connected — waiting for Chromium…"}
              {status === "reconnecting" && (
                <>
                  <span className="text-amber-400">
                    Reconnecting (attempt {reconnectAttempt}/
                    {MAX_RECONNECT_ATTEMPTS})…
                  </span>
                  <span className="mt-1 text-xs text-neutral-500">
                    Lost connection to the stream server. Retrying with
                    backoff.
                  </span>
                </>
              )}
              {status === "error" && (
                <>
                  <span className="text-red-400">Error</span>
                  {errMsg && (
                    <span className="mt-1 text-xs text-neutral-500">{errMsg}</span>
                  )}
                </>
              )}
              {status === "unreachable" && (
                <>
                  <span className="text-red-400">Server unreachable</span>
                  <span className="mt-1 text-xs text-neutral-500">
                    {errMsg ??
                      `Could not reach the stream server after ${MAX_RECONNECT_ATTEMPTS} attempts.`}
                  </span>
                </>
              )}
              {status === "closed" && "Stream closed"}
            </div>
          )}
        </div>
      </div>

      {currentUrl && (
        <div className="hidden flex-shrink-0 truncate border-t border-neutral-800 bg-neutral-950 px-3 py-1 font-mono text-[11px] text-neutral-500 sm:block">
          {currentUrl}
        </div>
      )}

      {recordingId && endingState !== "idle" && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-neutral-950/85 px-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Recording finished"
            className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
          >
            <h2 className="text-base font-medium text-neutral-100">
              Recording finished
            </h2>
            <p className="mt-1 text-sm text-neutral-400">
              Give it a name, then save and let AI take a look — or
              discard if it isn&rsquo;t worth keeping.
            </p>
            <label className="mt-4 block text-xs uppercase tracking-wide text-neutral-500">
              Name
              <input
                value={endName}
                onChange={(e) => setEndName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busyEnding) {
                    e.preventDefault();
                    void saveAndAnalyze();
                  }
                }}
                placeholder="e.g. Booking flow for Acme"
                disabled={busyEnding}
                autoFocus
                maxLength={200}
                className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none disabled:opacity-50"
              />
            </label>
            {endError && (
              <p className="mt-2 text-xs text-red-400">{endError}</p>
            )}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => void discard()}
                disabled={busyEnding}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                {endingState === "discarding" ? "Discarding…" : "Discard"}
              </button>
              <button
                type="button"
                onClick={() => void saveAndAnalyze()}
                disabled={busyEnding}
                className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {endingState === "saving"
                  ? "Saving…"
                  : "Save & analyze with AI"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
