"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  RefreshCw,
  Maximize2,
  Minimize2,
  ExternalLink,
  Play,
  Square,
  Loader2,
  MousePointerClick,
  ImagePlus,
} from "lucide-react";

/**
 * Live preview with Test (local dev server) + Live (production) modes.
 * When Test is selected and the dev server is offline, the panel offers a
 * one-click "Start" that spawns the project's configured dev command via the
 * /api/projects/:id/dev endpoint.
 *
 * Screenshot button uses the Screen Capture API; stream is kept alive across
 * captures so the picker only shows once per session.
 */

export type PreviewMode = "test" | "live";

interface DevStatusDto {
  state: "idle" | "starting" | "ready" | "failed";
  port: number | null;
  pid: number | null;
  startedAt: number | null;
  logTail: string[];
  error: string | null;
  reachable: boolean;
}

export interface InspectorPick {
  path: string;
  line: number;
  col: number;
  context?: Record<string, unknown>;
}

export default function PreviewPane({
  projectId,
  testUrl,
  liveUrl,
  fullscreen,
  onToggleFullscreen,
  onScreenshot,
  queuedCount,
  canManageDev,
  onInspectorPick,
}: {
  projectId: string;
  testUrl: string | null;
  liveUrl: string | null;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onScreenshot: (file: File) => void;
  queuedCount: number;
  canManageDev: boolean;
  /** Fired when the user Alt+clicks an element in the preview. */
  onInspectorPick?: (pick: InspectorPick) => void;
}) {
  const [mode, setMode] = useState<PreviewMode>(testUrl ? "test" : "live");
  const [reloadKey, setReloadKey] = useState(0);
  const [devStatus, setDevStatus] = useState<DevStatusDto | null>(null);
  const [inspectorReady, setInspectorReady] = useState(false);
  const [inspectorArmed, setInspectorArmed] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const armInspector = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { source: "amaso-dashboard", type: "arm" },
      "*",
    );
    // Optimistically reflect the armed state — if the iframe never responds
    // (e.g. inspector script not loaded) the user gets visual feedback that
    // they tried, and the next pick or page reload will reset it.
    setInspectorArmed(true);
  }, []);

  const disarmInspector = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { source: "amaso-dashboard", type: "disarm" },
      "*",
    );
    setInspectorArmed(false);
  }, []);

  const activeUrl = mode === "test" ? testUrl : liveUrl;

  // Listen for messages from the injected inspector plugin
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e.data;
      if (!data || data.source !== "amaso-inspector") return;
      if (data.type === "ready") {
        setInspectorReady(true);
      } else if (data.type === "armed") {
        setInspectorArmed(true);
      } else if (data.type === "disarmed") {
        setInspectorArmed(false);
      } else if (data.type === "pick" && typeof data.path === "string") {
        setInspectorArmed(false);
        onInspectorPick?.({
          path: data.path,
          line: Number(data.line) || 1,
          col: Number(data.col) || 1,
          context:
            data.context && typeof data.context === "object"
              ? (data.context as Record<string, unknown>)
              : undefined,
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onInspectorPick]);

  useEffect(() => {
    setInspectorReady(false);
    setInspectorArmed(false);
    const timer = window.setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage(
        { source: "amaso-dashboard", type: "probe" },
        "*",
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [reloadKey, mode]);

  // Poll dev-server status in Test mode
  useEffect(() => {
    if (mode !== "test" || !testUrl) {
      setDevStatus(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    async function tick() {
      try {
        const res = await fetch(`/api/projects/${projectId}/dev`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as DevStatusDto;
        if (!cancelled) setDevStatus(data);
      } catch {
        // Dashboard dev-server mid-restart or similar — just retry next tick.
      } finally {
        if (!cancelled) {
          // Poll faster while booting
          const period =
            devStatus?.state === "starting" ? 1000 : 4000;
          timer = window.setTimeout(tick, period);
        }
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, mode, testUrl]);

  // When the dev server transitions to ready, force an iframe reload so the
  // user sees the live site instead of the "refused" error frame.
  const prevState = useRef<DevStatusDto["state"] | null>(null);
  useEffect(() => {
    if (!devStatus) return;
    if (prevState.current !== "ready" && devStatus.state === "ready") {
      setReloadKey((k) => k + 1);
    }
    prevState.current = devStatus.state;
  }, [devStatus]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  async function startDevServer() {
    await fetch(`/api/projects/${projectId}/dev`, { method: "POST" });
    // Status will update via poll loop
  }

  async function stopDevServer() {
    await fetch(`/api/projects/${projectId}/dev`, { method: "DELETE" });
  }

  const showOffline =
    mode === "test" &&
    devStatus &&
    devStatus.state !== "ready" &&
    !devStatus.reachable;

  return (
    <div className="flex h-full flex-col bg-black">
      {!fullscreen && (
        <Toolbar
          inline
          mode={mode}
          onModeChange={setMode}
          testUrl={testUrl}
          liveUrl={liveUrl}
          activeUrl={activeUrl}
          onReload={reload}
          onScreenshot={onScreenshot}
          queuedCount={queuedCount}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          devStatus={devStatus}
          canManageDev={canManageDev}
          onStartDev={startDevServer}
          onStopDev={stopDevServer}
          inspectorReady={inspectorReady}
          inspectorArmed={inspectorArmed}
          onArmInspector={armInspector}
          onDisarmInspector={disarmInspector}
        />
      )}
      <div className="relative flex-1 overflow-hidden bg-white">
        {showOffline ? (
          <OfflineState
            url={testUrl!}
            devStatus={devStatus}
            canManage={canManageDev}
            onStart={startDevServer}
          />
        ) : activeUrl ? (
          <iframe
            ref={iframeRef}
            key={`${mode}-${reloadKey}`}
            src={activeUrl}
            title="Project preview"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-500">
            No {mode === "test" ? "test" : "live"} URL configured.
          </div>
        )}
        {fullscreen && (
          <Toolbar
            inline={false}
            mode={mode}
            onModeChange={setMode}
            testUrl={testUrl}
            liveUrl={liveUrl}
            activeUrl={activeUrl}
            onReload={reload}
            onScreenshot={onScreenshot}
            queuedCount={queuedCount}
            fullscreen={fullscreen}
            onToggleFullscreen={onToggleFullscreen}
            devStatus={devStatus}
            canManageDev={canManageDev}
            onStartDev={startDevServer}
            onStopDev={stopDevServer}
            inspectorReady={inspectorReady}
            inspectorArmed={inspectorArmed}
            onArmInspector={armInspector}
            onDisarmInspector={disarmInspector}
          />
        )}
      </div>
    </div>
  );
}

function Toolbar({
  inline,
  mode,
  onModeChange,
  testUrl,
  liveUrl,
  activeUrl,
  onReload,
  onScreenshot,
  queuedCount,
  fullscreen,
  onToggleFullscreen,
  devStatus,
  canManageDev,
  onStartDev,
  onStopDev,
  inspectorReady,
  inspectorArmed,
  onArmInspector,
  onDisarmInspector,
}: {
  inline: boolean;
  mode: PreviewMode;
  onModeChange: (m: PreviewMode) => void;
  testUrl: string | null;
  liveUrl: string | null;
  activeUrl: string | null;
  onReload: () => void;
  onScreenshot: (file: File) => void;
  queuedCount: number;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  devStatus: DevStatusDto | null;
  canManageDev: boolean;
  onStartDev: () => void;
  onStopDev: () => void;
  inspectorReady: boolean;
  inspectorArmed: boolean;
  onArmInspector: () => void;
  onDisarmInspector: () => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [capStatus, setCapStatus] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => () => stopStream(streamRef.current), []);

  async function capture() {
    if (capturing) return;
    setCapturing(true);
    setCapStatus(null);
    try {
      const stream = await ensureStream(streamRef, (m) => setCapStatus(m));
      if (!stream) return;
      const track = stream.getVideoTracks()[0];
      const blob = await grabFrameAsPng(track);
      if (!blob) {
        setCapStatus("Capture failed");
        setTimeout(() => setCapStatus(null), 2500);
        return;
      }
      const file = new File(
        [blob],
        `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
        { type: "image/png" },
      );
      onScreenshot(file);
      setCapStatus("Added to remark");
      setTimeout(() => setCapStatus(null), 1800);
    } finally {
      setCapturing(false);
    }
  }

  const screenshotLabel =
    queuedCount > 0 ? `Screenshot (${queuedCount})` : "Screenshot";

  const wrapperClass = inline
    ? "flex flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-950/80 px-3 py-2 text-xs"
    : "pointer-events-none absolute right-4 top-4 z-20 flex items-center gap-2";

  const innerClass = inline
    ? "flex flex-wrap items-center gap-2"
    : "pointer-events-auto flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-950/90 px-2 py-1.5 text-xs shadow-lg backdrop-blur";

  return (
    <div className={wrapperClass}>
      <div className={innerClass}>
        {/* Test / Live toggle */}
        <div className="flex overflow-hidden rounded border border-neutral-800">
          <ModeBtn
            active={mode === "test"}
            onClick={() => onModeChange("test")}
            disabled={!testUrl}
            tone="sky"
          >
            Test
          </ModeBtn>
          <ModeBtn
            active={mode === "live"}
            onClick={() => onModeChange("live")}
            disabled={!liveUrl}
            tone="lime"
          >
            Live
          </ModeBtn>
        </div>

        {/* Dev server mini-status pill (Test mode only) */}
        {mode === "test" && devStatus && (
          <DevPill
            status={devStatus}
            canManage={canManageDev}
            onStart={onStartDev}
            onStop={onStopDev}
          />
        )}

        <button
          type="button"
          onClick={onReload}
          title="Reload"
          className="flex items-center gap-1 rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:border-neutral-700"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>

        {/* URL display: desktop-only. Phone users see the URL in their
            own browser address bar when they open the iframe target. */}
        {inline && activeUrl && (
          <span className="hidden max-w-xs truncate rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-300 md:inline-flex">
            {activeUrl}
          </span>
        )}
        {/* Open-in-new-tab: desktop-only. Rarely needed on mobile and
            the URL isn't even visible there. */}
        {activeUrl && (
          <a
            href={activeUrl}
            target="_blank"
            rel="noreferrer"
            title="Open in new tab"
            className="hidden rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:border-neutral-700 sm:inline-flex"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}

        {/* Inspect button — works on any device. Tapping arms the inspector
            for one pick (mobile-friendly). On desktop you can still hold Alt
            and click directly without using the button. */}
        {inspectorReady && (
          <button
            type="button"
            onClick={inspectorArmed ? onDisarmInspector : onArmInspector}
            title={
              inspectorArmed
                ? "Cancel inspect mode"
                : "Tap to enter inspect mode, then tap any element in the preview. Desktop: Alt+click works directly."
            }
            className={
              inline
                ? `flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${
                    inspectorArmed
                      ? "border-amber-500 bg-amber-500 text-black"
                      : "border-orange-700/50 bg-orange-900/20 text-orange-200 hover:border-orange-600"
                  }`
                : `flex items-center gap-1 rounded-full px-3 py-1 text-[11px] ${
                    inspectorArmed
                      ? "bg-amber-500 font-medium text-black"
                      : "bg-orange-900/80 text-orange-200"
                  }`
            }
          >
            <MousePointerClick className="h-3 w-3" />
            {inspectorArmed ? "Tap an element…" : "Inspect"}
          </button>
        )}

        <button
          type="button"
          onClick={capture}
          disabled={capturing}
          title="Capture the current view and attach it to a new remark"
          className={
            inline
              ? "flex items-center gap-1 rounded border border-amber-700/50 bg-amber-900/30 px-2 py-1 text-amber-200 hover:border-amber-600 disabled:opacity-50"
              : "flex items-center gap-1 rounded-full bg-amber-600 px-3 py-1 font-medium text-black hover:bg-amber-500 disabled:opacity-50"
          }
        >
          <Camera className="h-3.5 w-3.5" /> {screenshotLabel}
        </button>

        {/* Photo/upload fallback — works on mobile (iOS Safari can't do
            getDisplayMedia). Opens the device camera or photo library. */}
        <label
          title="Upload a photo or take one with your camera"
          className={
            inline
              ? "flex cursor-pointer items-center gap-1 rounded border border-amber-700/50 bg-amber-900/20 px-2 py-1 text-amber-200 hover:border-amber-600"
              : "flex cursor-pointer items-center gap-1 rounded-full border border-amber-600 bg-amber-700/70 px-3 py-1 font-medium text-amber-100 hover:bg-amber-700"
          }
        >
          <ImagePlus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              for (const f of files) onScreenshot(f);
              e.target.value = "";
            }}
          />
        </label>

        <button
          type="button"
          onClick={onToggleFullscreen}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          className={
            inline
              ? "rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:border-neutral-700"
              : "flex items-center gap-1 rounded-full px-2 py-1 text-neutral-300 hover:bg-neutral-800"
          }
        >
          {fullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </button>

        {capStatus && (
          <span className="text-[10px] text-neutral-300">{capStatus}</span>
        )}
      </div>
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  disabled,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  tone: "sky" | "lime";
  children: React.ReactNode;
}) {
  const activeStyle =
    tone === "sky"
      ? "bg-sky-900/50 text-sky-200"
      : "bg-lime-500/15 text-lime-300 ring-1 ring-lime-400/30";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-1 text-[11px] uppercase tracking-wide transition ${
        active ? activeStyle : "text-neutral-400 hover:bg-neutral-900"
      } disabled:opacity-30`}
    >
      {children}
    </button>
  );
}

function DevPill({
  status,
  canManage,
  onStart,
  onStop,
}: {
  status: DevStatusDto;
  canManage: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const { state, reachable, port } = status;
  let label = "offline";
  let dot = "bg-neutral-500";
  if (state === "ready" || reachable) {
    label = `dev :${port}`;
    dot = "bg-orange-500";
  } else if (state === "starting") {
    label = "starting…";
    dot = "bg-amber-500";
  } else if (state === "failed") {
    label = "failed";
    dot = "bg-red-500";
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-300">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {state === "starting" && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
      {canManage && state !== "ready" && !reachable && (
        <button
          type="button"
          onClick={onStart}
          className="ml-1 flex items-center gap-0.5 rounded bg-neutral-800 px-1.5 py-0.5 hover:bg-neutral-700"
          title="Start dev server"
        >
          <Play className="h-2.5 w-2.5" /> start
        </button>
      )}
      {canManage && (state === "ready" || reachable) && status.pid && (
        <button
          type="button"
          onClick={onStop}
          className="ml-1 flex items-center gap-0.5 rounded bg-neutral-800 px-1.5 py-0.5 hover:bg-neutral-700"
          title="Stop dev server"
        >
          <Square className="h-2.5 w-2.5" /> stop
        </button>
      )}
    </span>
  );
}

function OfflineState({
  url,
  devStatus,
  canManage,
  onStart,
}: {
  url: string;
  devStatus: DevStatusDto;
  canManage: boolean;
  onStart: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center">
      <div>
        <h3 className="text-base font-medium text-neutral-200">
          Dev server is offline
        </h3>
        <p className="mt-1 font-mono text-xs text-neutral-500">{url}</p>
      </div>
      {devStatus.state === "failed" && devStatus.error && (
        <p className="max-w-md text-xs text-red-400">
          Last error: {devStatus.error}
        </p>
      )}
      {canManage ? (
        <button
          type="button"
          onClick={onStart}
          disabled={devStatus.state === "starting"}
          className="flex items-center gap-2 rounded-full bg-sky-500 px-4 py-2 text-sm font-medium text-black hover:bg-sky-400 disabled:opacity-50"
        >
          {devStatus.state === "starting" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Starting…
            </>
          ) : (
            <>
              <Play className="h-4 w-4" /> Start dev server
            </>
          )}
        </button>
      ) : (
        <p className="text-xs text-neutral-500">
          Ask an admin to start the dev server.
        </p>
      )}
      {devStatus.logTail.length > 0 && (
        <details className="max-w-xl text-left">
          <summary className="cursor-pointer text-xs text-neutral-500">
            Recent log
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded border border-neutral-800 bg-neutral-900 p-2 text-[10px] text-neutral-400">
            {devStatus.logTail.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

async function ensureStream(
  ref: React.MutableRefObject<MediaStream | null>,
  onError: (msg: string) => void,
): Promise<MediaStream | null> {
  if (ref.current && ref.current.active) return ref.current;
  try {
    const opts = {
      video: true,
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      systemAudio: "exclude",
    } as unknown as MediaStreamConstraints;
    const stream = await navigator.mediaDevices.getDisplayMedia(opts);
    ref.current = stream;
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      ref.current = null;
    });
    return stream;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    onError(`Permission denied: ${msg}`);
    setTimeout(() => onError(""), 4000);
    return null;
  }
}

function stopStream(s: MediaStream | null) {
  if (!s) return;
  s.getTracks().forEach((t) => t.stop());
}

async function grabFrameAsPng(track: MediaStreamTrack): Promise<Blob | null> {
  interface MinimalImageCapture {
    grabFrame(): Promise<ImageBitmap>;
  }
  type ImageCaptureCtor = new (track: MediaStreamTrack) => MinimalImageCapture;
  const G = globalThis as unknown as { ImageCapture?: ImageCaptureCtor };
  if (G.ImageCapture) {
    try {
      const capture = new G.ImageCapture(track);
      const bitmap = await capture.grabFrame();
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
        return await canvasToPng(canvas);
      }
    } catch {
      /* fall through to video fallback */
    }
  }
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    const onReady = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(video, 0, 0);
      video.pause();
      video.srcObject = null;
      resolve(await canvasToPng(canvas));
    };
    video.onloadedmetadata = () => {
      video.play().then(() => {
        requestAnimationFrame(onReady);
      });
    };
    setTimeout(() => resolve(null), 4000);
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
}
