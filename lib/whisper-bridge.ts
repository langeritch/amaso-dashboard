/**
 * Thin Node client for the Python service's /transcribe endpoint.
 *
 * The actual Whisper model lives in `telegram-voice/stt_bridge.py`
 * and is loaded once when the Python sidecar boots. We just POST raw
 * 16 kHz mono s16le PCM bytes to it and read the recognised text out
 * of the JSON response. The shared bearer token (TELEGRAM_VOICE_TOKEN)
 * gates the endpoint the same way the rest of the Python surface does.
 *
 * Used by lib/companion-spar-relay.ts to transcribe the audio buffer
 * the menu-bar app streams up over the companion WebSocket.
 */

const DEFAULT_BASE = "http://127.0.0.1:8765";
const DEFAULT_SAMPLE_RATE = 16_000;

function baseUrl(): string {
  return (process.env.TELEGRAM_VOICE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function token(): string {
  return (process.env.TELEGRAM_VOICE_TOKEN || "").trim();
}

export interface TranscribeResult {
  text: string;
  /** Duration of the supplied audio buffer in milliseconds. */
  ms: number;
  /** Set when the endpoint short-circuited (empty body, sub-100ms,
   *  no samples). text will be "" in that case. */
  skipped?: string;
}

/**
 * Send raw PCM audio to the Python service's Whisper bridge.
 *
 * @param pcm Raw mono s16le bytes. The endpoint also accepts other
 *            sample rates; pass the matching `sampleRate`.
 * @param sampleRate Sample rate of the supplied PCM in Hz. Defaults
 *            to 16000 (Whisper's native rate; no resample on the
 *            server). The companion currently sends 16 kHz mono.
 *
 * Throws if the Python service is unreachable or returns a non-2xx.
 * Returns { text: "", skipped: "..." } for buffers too short to
 * transcribe rather than throwing; callers treat that as silence.
 */
export async function transcribePcm(
  pcm: Buffer,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): Promise<TranscribeResult> {
  const tok = token();
  if (!tok) {
    throw new Error(
      "TELEGRAM_VOICE_TOKEN is not set; the Python service won't authorise the transcribe call",
    );
  }
  const url = `${baseUrl()}/transcribe`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/octet-stream",
      "X-Sample-Rate": String(Math.floor(sampleRate)),
    },
    // Wrap the buffer in an ArrayBuffer view so the fetch type-checker
    // accepts it. Node's BodyInit type accepts ArrayBuffer / Blob /
    // string / URLSearchParams, not Buffer or Uint8Array directly,
    // even though both work at runtime via its iterable hook.
    body: pcm.buffer.slice(
      pcm.byteOffset,
      pcm.byteOffset + pcm.byteLength,
    ) as ArrayBuffer,
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `transcribe failed: ${res.status} ${detail.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as TranscribeResult;
  return {
    text: typeof body.text === "string" ? body.text : "",
    ms: typeof body.ms === "number" ? body.ms : 0,
    skipped: typeof body.skipped === "string" ? body.skipped : undefined,
  };
}
