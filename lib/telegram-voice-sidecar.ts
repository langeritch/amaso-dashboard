import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { resolve } from "node:path";

const PYTHON =
  process.env.TELEGRAM_VOICE_PYTHON ??
  resolve(process.cwd(), "telegram-voice/.venv/Scripts/python.exe");
const SCRIPT = resolve(process.cwd(), "telegram-voice/service.py");
const PORT = Number(
  process.env.TELEGRAM_VOICE_PORT ?? process.env.SERVICE_PORT ?? "8765",
);

let child: ChildProcess | null = null;

export function getTelegramVoicePort(): number {
  return PORT;
}

async function portInUse(p: number): Promise<boolean> {
  return await new Promise<boolean>((res) => {
    const sock = tcpConnect({ host: "127.0.0.1", port: p });
    sock.once("connect", () => {
      sock.destroy();
      res(true);
    });
    sock.once("error", () => {
      sock.destroy();
      res(false);
    });
  });
}

export async function startTelegramVoice(): Promise<void> {
  if (child && child.exitCode === null) return;
  // A prior dev run or a manual `python service.py` may already own
  // :8765 — reuse it rather than fighting for the bind. Matches the
  // Kokoro sidecar so a server-only restart doesn't drop an active
  // call or force a fresh Pyrogram / Whisper model load.
  if (await portInUse(PORT)) {
    console.log(
      `[telegram-voice] service already running on :${PORT}, skipping spawn`,
    );
    return;
  }
  child = spawn(PYTHON, [SCRIPT], {
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  child.on("exit", (code, signal) => {
    console.error(`[telegram-voice] exited code=${code} signal=${signal}`);
    child = null;
  });
  const cleanup = () => {
    if (!child || child.exitCode !== null) return;
    // pytgcalls spawns a native ntgcalls helper; a plain child.kill()
    // leaves the helper running and holding the mic device and UDP
    // sockets. Tree-kill on Windows gets everyone.
    if (process.platform === "win32" && child.pid) {
      try {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
          windowsHide: true,
        });
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}
