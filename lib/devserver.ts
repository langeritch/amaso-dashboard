// Manages per-project dev servers (Nuxt, Next, Vite, etc). Spawns `npm run
// dev` with the project-configured port, polls the port until it's
// reachable, exposes a status + recent log output.
//
// Scope is modest: one dev server per project, spawned by an admin user,
// killed on dashboard restart (no auto-resume by design — less surprising
// than silently reviving a process).

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { getProject, type ProjectConfig } from "./config";

export type DevState = "idle" | "starting" | "ready" | "failed";

export interface DevStatus {
  state: DevState;
  port: number | null;
  pid: number | null;
  startedAt: number | null;
  logTail: string[];
  error: string | null;
}

interface DevProcess {
  proc: ChildProcess;
  port: number;
  startedAt: number;
  status: DevStatus;
  log: string[]; // ring buffer, recent lines
}

const MAX_LOG_LINES = 200;
const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 120_000;

declare global {
  // eslint-disable-next-line no-var
  var __amasoDev: Map<string, DevProcess> | undefined;
}

function registry(): Map<string, DevProcess> {
  if (!globalThis.__amasoDev) globalThis.__amasoDev = new Map();
  return globalThis.__amasoDev;
}

function parsePort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const p = new URL(url).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

/**
 * The local port a project's dev server listens on. Prefers explicit
 * `devPort` in config (required when previewUrl is a public HTTPS hostname);
 * falls back to parsing the port out of previewUrl for legacy configs.
 */
function projectDevPort(project: ProjectConfig): number | null {
  if (typeof project.devPort === "number") return project.devPort;
  return parsePort(project.previewUrl);
}

function buildCommand(project: ProjectConfig, port: number): string {
  const template = project.devCommand ?? "npm run dev -- --port {{PORT}}";
  return template.replace(/\{\{PORT\}\}/g, String(port));
}

async function tryConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

/**
 * Is anything listening on this port? We probe IPv4 AND IPv6 because Vite,
 * Next, and Nuxt all sometimes bind only to `::1` on modern Node/Windows
 * setups — if we only checked 127.0.0.1 we'd miss them and report "offline"
 * forever. The iframe's `localhost` resolves dual-stack so previews work,
 * but our server-side health check needs to match reality.
 */
async function isPortOpen(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    tryConnect(port, "127.0.0.1"),
    tryConnect(port, "::1"),
  ]);
  return v4 || v6;
}

function pushLog(dev: DevProcess, chunk: string) {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) continue;
    dev.log.push(line);
  }
  if (dev.log.length > MAX_LOG_LINES) {
    dev.log.splice(0, dev.log.length - MAX_LOG_LINES);
  }
  dev.status.logTail = dev.log.slice(-30);
}

export function getStatus(projectId: string): DevStatus {
  const reg = registry();
  const dev = reg.get(projectId);
  if (!dev) {
    const project = getProject(projectId);
    const port = project ? projectDevPort(project) : null;
    return {
      state: "idle",
      port,
      pid: null,
      startedAt: null,
      logTail: [],
      error: null,
    };
  }
  return dev.status;
}

export async function liveCheck(projectId: string): Promise<boolean> {
  const project = getProject(projectId);
  const port = project ? projectDevPort(project) : null;
  if (!port) return false;
  return isPortOpen(port);
}

export async function start(projectId: string): Promise<DevStatus> {
  const reg = registry();
  const existing = reg.get(projectId);
  if (
    existing &&
    existing.proc && // null for "external process already listening" entries
    existing.proc.exitCode === null &&
    (existing.status.state === "ready" || existing.status.state === "starting")
  ) {
    return existing.status;
  }

  const project = getProject(projectId);
  if (!project) throw new Error("project_not_found");
  const port = projectDevPort(project);
  if (!port) throw new Error("no_preview_url_or_port");

  // If something else already owns the port, consider it "ready" (maybe the
  // user started it by hand).
  if (await isPortOpen(port)) {
    const fake: DevProcess = {
      proc: null as unknown as ChildProcess,
      port,
      startedAt: Date.now(),
      status: {
        state: "ready",
        port,
        pid: null,
        startedAt: Date.now(),
        logTail: ["(external process already listening on this port)"],
        error: null,
      },
      log: ["(external process already listening on this port)"],
    };
    reg.set(projectId, fake);
    return fake.status;
  }

  const cmd = buildCommand(project, port);
  const cwd = project.path;
  const isWindows = process.platform === "win32";

  // `shell: true` is required on Windows for `npm` to resolve, and convenient
  // for user-written commands that might include `&&`, pipes, etc.
  const proc = spawn(cmd, {
    cwd,
    shell: true,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0" },
    detached: false,
  });

  const dev: DevProcess = {
    proc,
    port,
    startedAt: Date.now(),
    status: {
      state: "starting",
      port,
      pid: proc.pid ?? null,
      startedAt: Date.now(),
      logTail: [],
      error: null,
    },
    log: [],
  };
  reg.set(projectId, dev);

  proc.stdout?.on("data", (d) => pushLog(dev, d.toString()));
  proc.stderr?.on("data", (d) => pushLog(dev, d.toString()));
  proc.on("exit", (code, signal) => {
    // If we were still "starting", flip to failed. If we were "ready", note
    // that the server exited but keep logs for inspection.
    dev.status.pid = null;
    if (dev.status.state !== "ready") {
      dev.status.state = "failed";
      dev.status.error = `Process exited (code=${code ?? "?"} signal=${signal ?? "?"})`;
    } else {
      dev.status.state = "idle";
      dev.status.error = "process exited";
    }
  });

  // Poll the port until it opens or we time out
  void (async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) return;
      if (await isPortOpen(port)) {
        dev.status.state = "ready";
        return;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (dev.status.state === "starting") {
      dev.status.state = "failed";
      dev.status.error = "timed out waiting for port to open";
      try {
        stop(projectId);
      } catch {
        /* swallow */
      }
    }
  })();

  return dev.status;
}

export function stop(projectId: string): void {
  const reg = registry();
  const dev = reg.get(projectId);
  if (!dev || !dev.proc) {
    reg.delete(projectId);
    return;
  }
  if (dev.proc.exitCode === null) {
    // On Windows, kill() only kills the shell — the child npm/nuxt survives.
    // Use taskkill with /T to end the whole tree.
    if (process.platform === "win32" && dev.proc.pid) {
      spawn("taskkill", ["/pid", String(dev.proc.pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
      });
    } else {
      dev.proc.kill("SIGTERM");
    }
  }
  reg.delete(projectId);
}

/** Clean shutdown: stop every managed dev server. Called on server exit. */
export function stopAll() {
  for (const id of Array.from(registry().keys())) stop(id);
}

// Best-effort cleanup when the dashboard itself goes down
if (!globalThis.__amasoDevCleanupRegistered) {
  globalThis.__amasoDevCleanupRegistered = true as never;
  process.on("exit", stopAll);
  process.on("SIGINT", () => {
    stopAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopAll();
    process.exit(0);
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoDevCleanupRegistered: boolean | undefined;
}
