import { NextRequest } from "next/server";
import { getKokoroPort } from "@/lib/kokoro";
import { getCurrentUser } from "@/lib/auth";
import { getSession } from "@/lib/voice-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { text?: unknown; voice?: unknown; speed?: unknown; lang?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return new Response("empty text", { status: 400 });

  // Audio-routing guard: if the caller's voice session is currently
  // on the Telegram channel, the phone call is voicing the reply.
  // Returning 204 (no content) tells the browser not to play anything
  // and is cheaper than synthesising a WAV we'd just throw away.
  // This also protects any TTS consumer that hasn't internally gated
  // itself yet (dashboard chat, future voice features).
  const user = await getCurrentUser();
  if (user) {
    const session = getSession(user.id);
    if (session?.channel === "telegram") {
      return new Response(null, {
        status: 204,
        headers: { "X-Amaso-Muted": "telegram-call-active" },
      });
    }
  }

  const payload: Record<string, unknown> = { text };
  if (typeof body?.voice === "string") payload.voice = body.voice;
  if (typeof body?.speed === "number") payload.speed = body.speed;
  if (typeof body?.lang === "string") payload.lang = body.lang;

  const port = getKokoroPort();
  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${port}/synth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (err) {
    return new Response(`kokoro sidecar unreachable: ${String(err).slice(0, 120)}`, {
      status: 502,
    });
  }
  if (!upstream.ok) {
    const msg = await upstream.text().catch(() => "synth failed");
    return new Response(msg, { status: upstream.status });
  }
  const ab = await upstream.arrayBuffer();
  return new Response(ab, {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(ab.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
