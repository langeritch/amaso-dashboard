import { spawn, type ChildProcess } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { resolve } from "node:path";

const PYTHON = process.env.TTS_PYTHON ?? "C:/Users/santi/tools/tts/venv/Scripts/python.exe";
const SCRIPT = resolve(process.cwd(), "scripts/kokoro_server.py");
const PORT = Number(process.env.TTS_PORT ?? "3939");

let child: ChildProcess | null = null;

export function getKokoroPort(): number {
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

export async function startKokoro(): Promise<void> {
  if (child && child.exitCode === null) return;
  // Another sidecar (from a prior dev run or a manual launch) already
  // owns the port — reuse it instead of fighting for the bind.
  if (await portInUse(PORT)) {
    console.log(`[kokoro] sidecar already running on :${PORT}, skipping spawn`);
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
    console.error(`[kokoro] exited code=${code} signal=${signal}`);
    child = null;
  });
  const cleanup = () => {
    if (child && child.exitCode === null) {
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
