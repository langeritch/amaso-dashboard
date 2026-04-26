/**
 * Thin client for the local telegram-voice Python service.
 *
 * The service itself lives in `telegram-voice/` and owns all the
 * Pyrogram / pytgcalls / Whisper / Kokoro plumbing. Node never
 * imports any of that — it just forwards intent over HTTP with a
 * shared-secret token.
 *
 * Config lives in env:
 *   TELEGRAM_VOICE_URL   (default http://127.0.0.1:8765)
 *   TELEGRAM_VOICE_TOKEN (must match SERVICE_TOKEN in the Python .env)
 */

const DEFAULT_BASE = "http://127.0.0.1:8765";

export type CallState =
  | "idle"
  | "dialing"
  | "ringing"
  | "connected"
  | "hanging_up"
  | "starting";

export interface TelegramVoiceStatus {
  state: CallState;
  peer_user_id?: number | null;
  peer_phone?: string | null;
  started_at?: number | null;
  connected_at?: number | null;
  last_event?: string | null;
  last_error?: string | null;
}

export class TelegramVoiceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramVoiceUnavailable";
  }
}

function baseUrl(): string {
  return (process.env.TELEGRAM_VOICE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function token(): string {
  const value = (process.env.TELEGRAM_VOICE_TOKEN || "").trim();
  if (!value) {
    throw new TelegramVoiceUnavailable(
      "TELEGRAM_VOICE_TOKEN is not set — the Python service won't authorise requests without it.",
    );
  }
  return value;
}

async function call<T>(
  path: string,
  init: RequestInit & { noAuth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (!init.noAuth) headers["x-auth"] = token();

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  } catch (err) {
    // Connection refused / DNS fail → the Python service isn't running.
    // Surface a typed error so callers can distinguish "not installed"
    // from "call failed for a legitimate reason".
    throw new TelegramVoiceUnavailable(
      `telegram-voice service unreachable at ${baseUrl()} — is it running? (${(err as Error).message})`,
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body?.detail ?? "";
    } catch {
      /* not JSON */
    }
    const base = `telegram-voice ${path} → ${res.status}`;
    throw new Error(detail ? `${base}: ${detail}` : base);
  }
  return (await res.json()) as T;
}

export async function getStatus(): Promise<TelegramVoiceStatus> {
  return call<TelegramVoiceStatus>("/status", { method: "GET", noAuth: true });
}

export interface StartCallInput {
  user_id?: number;
  phone?: string;
}

export async function startCall(input: StartCallInput = {}): Promise<TelegramVoiceStatus> {
  return call<TelegramVoiceStatus>("/call", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface SpeakInput {
  text: string;
  voice?: string;
  speed?: number;
}

export async function speak(input: SpeakInput): Promise<{ ok: boolean; bytes: number }> {
  return call<{ ok: boolean; bytes: number }>("/speak", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function hangup(): Promise<TelegramVoiceStatus> {
  return call<TelegramVoiceStatus>("/hangup", { method: "POST" });
}
