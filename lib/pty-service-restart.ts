// Restart the external amaso-pty-service process. Used by the
// Claude-account switcher so a fresh service comes up holding the
// new account's credentials — even though every spawn already
// receives the active account's CLAUDE_CONFIG_DIR via POST /sessions
// `env`, the service caches enough boot-time state (env at fork,
// any pre-account-switch sessions still being torn down, …) that the
// safest "I switched accounts, give me a clean slate" gesture is
// killing the service node and letting its watchdog respawn it.
//
// Mechanism: find whoever's LISTENING on the configured PTY-service
// port, taskkill the process tree, then prod the AmasoPTY-Service
// scheduled task so its watchdog respawns the service within seconds
// instead of waiting on the next health-poll tick. The watchdog's
// "adopt healthy listener" logic means the kick is a no-op when the
// service is already back up — safe to fire even if the watchdog
// beat us to the respawn.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { getPtyServiceUrl } from "./config";

/** Default service port — matches `amaso.config.json` ptyServiceUrl in
 *  practice. Used as a fallback when the URL can't be parsed. */
const DEFAULT_PTY_PORT = 7850;

/** Scheduled task that supervises the PTY service. Created by
 *  amaso-pty-service/scripts/install-task.ps1; the legacy name (no
 *  hyphen) is also probed so this works on installs that pre-date the
 *  rename. */
const TASK_NAMES = ["AmasoPTY-Service", "AmasoPtyService"];

function parsePort(url: string): number {
  try {
    const u = new URL(url);
    const p = Number(u.port);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_PTY_PORT;
}

/** Find the PID currently LISTENING on `port`. Uses netstat -ano so we
 *  don't have to depend on a Node port-scan library. Returns null when
 *  nothing's bound — common transient state right after a restart. */
function findListenerPid(port: number): number | null {
  if (process.platform !== "win32") {
    // Non-Windows hosts don't run the dashboard in production; return
    // null so the caller logs and gives up rather than spinning here.
    return null;
  }
  const result = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const portStr = `:${port}`;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.includes(portStr)) continue;
    if (!line.includes("LISTENING")) continue;
    // Lines look like:
    //   "  TCP    127.0.0.1:7850         0.0.0.0:0    LISTENING    9532"
    // The PID is the last whitespace-separated column.
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[cols.length - 1]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

function killProcessTree(pid: number): boolean {
  if (process.platform !== "win32") return false;
  // /T walks children (claude.exe descendants), /F skips the polite
  // close-window step the service can't honour anyway. spawnSync so
  // we can confirm exit before triggering the scheduled-task respawn
  // and avoid racing the watchdog into killing a fresh process.
  const r = spawnSync(
    "taskkill.exe",
    ["/PID", String(pid), "/T", "/F"],
    { encoding: "utf8", windowsHide: true },
  );
  return r.status === 0;
}

function kickScheduledTask(): void {
  if (process.platform !== "win32") return;
  // Try every known name. The first one that the operator has
  // registered will succeed; the others 1-and-done with a non-zero
  // exit and we move on. The watchdog respawn (which honours
  // MultipleInstances=IgnoreNew on the task) handles the case where
  // the watchdog is already running and would adopt the new listener
  // anyway — extra fire is cheap.
  for (const name of TASK_NAMES) {
    spawnSync("schtasks.exe", ["/Run", "/TN", name], {
      encoding: "utf8",
      windowsHide: true,
    });
  }
}

export interface RestartPtyServiceResult {
  /** True when we found and killed a listener. False means no listener
   *  was bound (the service was already down, or the port lookup
   *  failed). The schtasks kick still fires either way so a missing
   *  service comes back up. */
  killed: boolean;
  /** PID we killed, when we killed one. Surfaced for log correlation. */
  pid: number | null;
  /** Port we probed, for diagnostics when the kill misses. */
  port: number;
}

/**
 * Kill the PTY service process and prompt the watchdog to respawn it.
 * Returns immediately — the actual respawn happens in the watchdog
 * (sub-second on a kicked schtasks /Run, sub-30s on the inner-loop
 * health probe even without the kick). Idempotent and safe to call
 * when the service is already down.
 */
export function restartPtyServiceProcess(): RestartPtyServiceResult {
  const url = getPtyServiceUrl();
  if (!url) {
    return { killed: false, pid: null, port: 0 };
  }
  const port = parsePort(url);
  const pid = findListenerPid(port);
  let killed = false;
  if (pid !== null) {
    killed = killProcessTree(pid);
    if (killed) {
      console.log(
        `[pty-service-restart] killed pid=${pid} on :${port}; kicking watchdog`,
      );
    } else {
      console.warn(
        `[pty-service-restart] taskkill failed for pid=${pid} on :${port}; still kicking watchdog`,
      );
    }
  } else {
    console.log(
      `[pty-service-restart] no listener on :${port}; just kicking watchdog`,
    );
  }
  kickScheduledTask();
  return { killed, pid, port };
}
