"use client";

// Spar v2 viewer — xterm.js attached to the singleton Hermes session
// running inside WSL2 tmux on the dashboard host. Companion to lib/
// spar2-ws.ts and lib/spar2-session.ts.
//
// Intentionally minimal compared to TerminalPane.tsx (the per-project
// Claude terminal). v2 is "watch + type into the sparring partner" —
// no voice, no TTS, no mobile-keyboard tricks. Those can be lifted
// over later if v2 graduates from being the experimental tab.

import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

interface Spar2Status {
  type: "status";
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  cols: number;
  rows: number;
  scrollback: string;
}
interface Spar2Data {
  type: "data";
  data: string;
}
interface Spar2Exit {
  type: "exit";
  exitCode: number | null;
  signal: number | null;
}
interface Spar2Error {
  type: "error";
  message: string;
}
type Spar2Msg = Spar2Status | Spar2Data | Spar2Exit | Spar2Error;

export default function Spar2Pane() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<unknown>(null); // xterm Terminal instance
  const fitRef = useRef<unknown>(null); // FitAddon instance
  const wsRef = useRef<WebSocket | null>(null);
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState("connecting…");
  const reconnectTimerRef = useRef<number | null>(null);

  // Build the wss:// URL using the page origin so this works through the
  // tunnel (https://dashboard.amaso.nl) and locally (http://127.0.0.1:3737)
  // without any config flag. Same trick the per-project terminal uses.
  const buildWsUrl = useCallback(() => {
    if (typeof window === "undefined") return "";
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/api/spar2`;
  }, []);

  // Mount xterm + connect WS once. Unmount cleans up both.
  useEffect(() => {
    let disposed = false;
    let term: {
      write: (s: string) => void;
      onData: (cb: (s: string) => void) => void;
      onResize: (cb: (e: { cols: number; rows: number }) => void) => void;
      dispose: () => void;
      cols: number;
      rows: number;
    } | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed || !hostRef.current) return;

      const t = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily:
          'ui-monospace, "JetBrains Mono", Menlo, Consolas, "Courier New", monospace',
        theme: {
          background: "#0b0d10",
          foreground: "#e6e8eb",
          cursor: "#ff6b3d",
          cursorAccent: "#0b0d10",
          selectionBackground: "#2d3440",
        },
        allowProposedApi: true,
        scrollback: 10_000,
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.loadAddon(new WebLinksAddon());
      t.open(hostRef.current);
      fit.fit();
      t.focus();

      // Cast for the duration of this closure; the public xterm API isn't
      // typed precisely enough for the surface we use.
      term = t as unknown as typeof term;
      termRef.current = t;
      fitRef.current = fit;

      connect();

      // Window resizes refit and notify the server. Throttled-to-rAF via
      // a single boolean — multiple resize events inside one frame coalesce.
      let resizeQueued = false;
      function onResize() {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
          resizeQueued = false;
          try {
            fit.fit();
          } catch {
            /* xterm internals can race during teardown */
          }
          if (term && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              }),
            );
          }
        });
      }
      window.addEventListener("resize", onResize);

      // Forward keystrokes to the server (which feeds them into the PTY,
      // which feeds them into tmux, which feeds them into hermes).
      t.onData((data: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", data }));
        }
      });
      // Server-side resize on tab-focus or font change too.
      t.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      return () => {
        window.removeEventListener("resize", onResize);
      };
    })();

    function connect() {
      if (disposed) return;
      const url = buildWsUrl();
      if (!url) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setStatusText("connecting…");

      ws.onopen = () => {
        setStatusText("connected");
        // Ask the server to start the session if it isn't running yet.
        // Idempotent on the server (start() returns existing status if
        // already up) so a reconnecting tab won't double-spawn.
        const cols = (term?.cols ?? 100) | 0;
        const rows = (term?.rows ?? 30) | 0;
        ws.send(JSON.stringify({ type: "start", cols, rows }));
      };

      ws.onmessage = (ev) => {
        let msg: Spar2Msg;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }
        if (msg.type === "data") {
          term?.write(msg.data);
        } else if (msg.type === "status") {
          setRunning(msg.running);
          setStatusText(
            msg.running ? `running (pid ${msg.pid ?? "?"})` : "not running",
          );
        } else if (msg.type === "exit") {
          setRunning(false);
          setStatusText(
            `exited code=${msg.exitCode ?? "?"} signal=${msg.signal ?? "-"}`,
          );
          term?.write(
            `\r\n\x1b[33m[hermes exited code=${msg.exitCode ?? "?"} ` +
              `signal=${msg.signal ?? "-"}]\x1b[0m\r\n`,
          );
        } else if (msg.type === "error") {
          setStatusText(`error: ${msg.message}`);
          term?.write(`\r\n\x1b[31m[server error: ${msg.message}]\x1b[0m\r\n`);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setStatusText("disconnected — reconnecting in 2s…");
        // Auto-reconnect with a fixed 2 s backoff. The session itself
        // (hermes inside tmux) keeps running — reconnect just re-attaches
        // the byte stream. No exponential here because the server side
        // can't be the cause of repeated rejects: auth is sticky for the
        // session cookie, the WS endpoint is healthy if any other tab
        // reconnects, etc.
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, 2000);
      };

      ws.onerror = () => {
        // ws.onclose runs after onerror — let close handle the reconnect.
        setStatusText("error");
      };
    }

    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try {
        wsRef.current?.close();
      } catch {
        /* already closed */
      }
      try {
        term?.dispose();
      } catch {
        /* already disposed */
      }
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [buildWsUrl]);

  // Operator-explicit hard kill. Detach is the default behaviour on
  // window close — this button is for "burn the conversation" intent.
  function killSession() {
    if (
      !confirm(
        "Kill the Hermes tmux session? This ends the conversation and a new one will start when you reload.",
      )
    )
      return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "kill" }));
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#0b0d10]">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-neutral-800 px-3 py-1 text-xs text-neutral-400">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${running ? "bg-orange-500" : "bg-neutral-600"}`}
          />
          <span>spar v2 · hermes/wsl/tmux</span>
          <span className="text-neutral-600">— {statusText}</span>
        </div>
        <button
          onClick={killSession}
          className="rounded border border-neutral-800 px-2 py-0.5 text-[10px] text-neutral-500 hover:border-red-900 hover:text-red-400"
          title="Kill the tmux session and end the conversation"
        >
          kill session
        </button>
      </div>
      <div ref={hostRef} className="flex-1 overflow-hidden" />
    </div>
  );
}
