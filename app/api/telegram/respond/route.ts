import { NextRequest, NextResponse } from "next/server";
import { collectFromClaudeCli, type SparMessage } from "@/lib/spar-claude";
import { readHeartbeat } from "@/lib/heartbeat";
import { mintToken, revokeToken } from "@/lib/spar-token";
import {
  SPAR_AUTOPILOT_SUFFIX,
  SPAR_MODEL,
  SPAR_SYSTEM_PROMPT,
  SPAR_TOOLS,
} from "@/lib/spar-prompt";
import { getDb } from "@/lib/db";
import {
  activateChannel,
  appendTurn,
  type VoiceSession,
} from "@/lib/voice-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Service-to-service endpoint driven by the Python telegram-voice
 * service. Each caller utterance comes in here; we fold it into the
 * user's active voice session (creating one or taking over an
 * existing Spar session as needed), call the SAME Claude sparring
 * partner stack Spar uses (same persona, same tools, same heartbeat,
 * same Opus model), and return the assistant's reply for Kokoro to
 * synthesise on the phone.
 *
 * The Telegram call is not a separate assistant. It IS Spar — the
 * audio just moved from speaker to phone. Running this endpoint
 * through a different system prompt, or with a stripped-down tool
 * list, would break that guarantee. Everything wires through
 * lib/spar-prompt so the two paths can't drift.
 *
 * Auth: `X-Auth` shared secret, same one Python uses for its own
 * internal `/speak`, `/call`, etc. No user session cookie involved —
 * the Python side runs out-of-band.
 */

interface Body {
  utterance?: string;
  caller_name?: string;
  user_id?: number; // optional override; defaults to the first admin
}

interface ReplyPayload {
  ok: boolean;
  reply?: string;
  session_id?: string;
  took_over_from?: "spar" | "chat" | null;
  turns?: VoiceSession["turns"];
  error?: string;
}

function requireToken(req: NextRequest): NextResponse | null {
  const expected = (process.env.TELEGRAM_VOICE_TOKEN || "").trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "TELEGRAM_VOICE_TOKEN not set on dashboard" },
      { status: 503 },
    );
  }
  if (req.headers.get("x-auth") !== expected) {
    return NextResponse.json({ ok: false, error: "bad token" }, { status: 401 });
  }
  return null;
}

function resolveUserId(override: number | undefined): number | null {
  if (typeof override === "number" && override > 0) return override;
  const envOverride = Number(process.env.AMASO_TELEGRAM_USER_ID || 0);
  if (envOverride > 0) return envOverride;
  // Default: first admin in the users table. Single-user installs
  // (the common case) just pick Santi automatically.
  const row = getDb()
    .prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

function dashboardBaseUrl(req: NextRequest): string {
  // The MCP server subprocess runs on this same host — loopback is
  // always right, even when the request itself arrived via a tunnel.
  const host = req.headers.get("host") ?? `127.0.0.1:${process.env.PORT ?? 3737}`;
  const port = host.includes(":") ? host.split(":").pop() : process.env.PORT ?? "3737";
  return `http://127.0.0.1:${port}`;
}

export async function POST(req: NextRequest): Promise<NextResponse<ReplyPayload>> {
  const authFail = requireToken(req);
  if (authFail) return authFail as NextResponse<ReplyPayload>;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const utterance = (body.utterance ?? "").trim();
  if (!utterance) {
    return NextResponse.json(
      { ok: false, error: "utterance required" },
      { status: 400 },
    );
  }

  const userId = resolveUserId(body.user_id);
  if (userId == null) {
    return NextResponse.json(
      { ok: false, error: "no admin user configured on dashboard" },
      { status: 400 },
    );
  }

  // Takeover: switching the session's audio channel to Telegram.
  // If the session was actively held by Spar/chat, tookOver is true
  // and previousChannel tells us where we came from.
  const { session, tookOver } = activateChannel(userId, "telegram");
  const tookOverFrom = tookOver
    ? (session.previousChannel as "spar" | "chat" | null)
    : null;

  // Append the caller's turn before we call Claude so it sees it in
  // history. This is the critical "same session" wiring — the next
  // streamFromClaudeCli call reads from the same session.turns.
  appendTurn(userId, "telegram", "user", utterance);

  const history: SparMessage[] = session.turns.map((t) => ({
    role: t.role,
    content: t.text,
  }));

  // Use the SAME persona, tools, and heartbeat Spar uses. The only
  // difference between "Spar on laptop" and "Spar on phone" should
  // be the audio channel — prompt, tool access, and memory have to
  // match exactly or the user will notice the hand-off.
  const heartbeat = readHeartbeat(userId);
  const token = mintToken(userId);
  const dashboardUrl = dashboardBaseUrl(req);

  // Phone calls default to autopilot-on: Santi can't see the
  // permission-gate dialogs while on the phone, so making him
  // approve each gate verbally would be terrible UX. Same safety
  // rails as the autopilot suffix defines (no destructive actions).
  const autopilot = true;

  let reply: string;
  try {
    const raw = await collectFromClaudeCli({
      systemPrompt: autopilot
        ? SPAR_SYSTEM_PROMPT + SPAR_AUTOPILOT_SUFFIX
        : SPAR_SYSTEM_PROMPT,
      heartbeat,
      history,
      model: SPAR_MODEL,
      tools: {
        token,
        dashboardUrl,
        allowedTools: SPAR_TOOLS,
      },
    });
    reply = raw.trim();
  } catch (err) {
    console.error("[telegram/respond] claude cli failed", err);
    reply =
      "Sorry, I'm having trouble thinking of a reply right now. Could you say that again?";
  } finally {
    revokeToken(token);
  }
  if (!reply) reply = "Hmm, let me think on that.";

  appendTurn(userId, "telegram", "assistant", reply);

  return NextResponse.json({
    ok: true,
    reply,
    session_id: session.id,
    took_over_from: tookOverFrom,
    turns: session.turns,
  });
}
