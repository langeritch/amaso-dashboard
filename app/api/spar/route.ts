import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { readHeartbeat } from "@/lib/heartbeat";
import { streamFromClaudeCli, type SparMessage } from "@/lib/spar-claude";
import { mintToken, revokeToken } from "@/lib/spar-token";
import {
  SPAR_AUTOPILOT_SUFFIX,
  SPAR_MODEL,
  SPAR_SYSTEM_PROMPT,
  SPAR_TOOLS,
} from "@/lib/spar-prompt";
import {
  formatGraphForPrompt,
  queryGraph,
} from "@/lib/knowledge-graph";
import {
  activateChannel,
  appendTurn,
  getSession,
  registerStreamAbort,
  releaseChannel,
  unregisterStreamAbort,
} from "@/lib/voice-session";
import { speak as telegramSpeak, TelegramVoiceUnavailable } from "@/lib/telegram-voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  // If the voice session is currently on the Telegram channel, the
  // phone is driving the assistant and the laptop must stay silent.
  // Returning 204 before we even talk to Claude keeps the server
  // from generating a reply that would race the phone's audio. The
  // Spar client also checks for 204 and leaves its transcript alone.
  const activeSession = getSession(user.id);
  if (activeSession?.channel === "telegram") {
    return new Response(null, {
      status: 204,
      headers: { "X-Amaso-Muted": "telegram-call-active" },
    });
  }

  let body: { messages?: IncomingMessage[]; autopilot?: boolean } | null = null;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const history = Array.isArray(body?.messages) ? body!.messages : [];
  const autopilot = body?.autopilot === true;
  let msgs: SparMessage[] = history
    .filter(
      (m): m is IncomingMessage =>
        !!m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .slice(-30);

  const heartbeat = readHeartbeat(user.id);

  // Pull the personalization profile from the knowledge graph —
  // entities + relationships accumulated across prior conversations.
  // The keyword hints come from the last few user turns so a
  // conversation about, say, "the dashboard" lifts dashboard-related
  // facts above unrelated ones in the ranking. Never blocks the
  // route on failure: queryGraph swallows read errors and the
  // formatter returns "" on empty input, which the prompt builder
  // then drops the section entirely.
  const recentUserText = msgs
    .filter((m) => m.role === "user")
    .slice(-4)
    .map((m) => m.content)
    .join(" ")
    .slice(0, 800);
  const keywords = recentUserText
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((w) => w.length >= 4);
  let profile = "";
  try {
    const result = await queryGraph(user.id, { keywords, limit: 60 });
    profile = formatGraphForPrompt(result);
  } catch (err) {
    console.warn(
      "[spar] queryGraph failed — continuing without profile:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Empty history → treat as the kickoff greeting. Seed a silent user
  // turn that tells Haiku to open the conversation itself.
  if (msgs.length === 0) {
    msgs = [
      {
        role: "user",
        content: `[kickoff] Open the call with a short spoken greeting for ${user.name}. Reference the heartbeat if there's anything specific to flag right now, otherwise keep it casual.`,
      },
    ];
  }

  // Write-through to the shared voice-session store. Spar turns land
  // in the same conversation the Telegram voice service sees — so
  // when Santi picks up the phone mid-Spar, the call has full memory
  // of what they were just talking about.
  //
  // Two cases worth thinking about:
  //
  //   Steady state: session.turns is already in sync with msgs except
  //     for the newest user message. Append just that and move on.
  //
  //   Post-restart: the Node server was restarted mid-conversation.
  //     The in-memory voice-session has 0 turns, but the browser
  //     kept the full history in localStorage. If we only append
  //     msgs[-1], every past turn is silently dropped and a Telegram
  //     call minutes later picks up with no memory. Instead, backfill
  //     any turns present in the client's history but missing from
  //     the session. That makes "start Spar, restart server, call on
  //     Telegram" work exactly the same as "start Spar, call on
  //     Telegram without restart".
  activateChannel(user.id, "spar");
  const sessionBefore = getSession(user.id);
  const sessionTurnsLen = sessionBefore?.turns.length ?? 0;
  if (sessionTurnsLen < msgs.length) {
    const missing = msgs.slice(sessionTurnsLen);
    for (const m of missing) {
      if (m.content.startsWith("[kickoff]")) continue;
      appendTurn(
        user.id,
        "spar",
        m.role === "user" ? "user" : "assistant",
        m.content,
      );
    }
  } else {
    const latestUser = msgs[msgs.length - 1];
    if (
      latestUser &&
      latestUser.role === "user" &&
      !latestUser.content.startsWith("[kickoff]")
    ) {
      appendTurn(user.id, "spar", "user", latestUser.content);
    }
  }

  const token = mintToken(user.id);
  const host = req.headers.get("host") ?? `127.0.0.1:${process.env.PORT ?? 3737}`;
  // Force loopback — even if the request came in via the tunnel, the MCP
  // server subprocess lives on this host and should hit 127.0.0.1 directly.
  const port = host.includes(":") ? host.split(":").pop() : process.env.PORT ?? "3737";
  const dashboardUrl = `http://127.0.0.1:${port}`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const abort = new AbortController();
      const onReqAbort = () => abort.abort();
      req.signal.addEventListener("abort", onReqAbort, { once: true });
      // Register with the shared session so a Telegram takeover can
      // cut us off — otherwise this stream happily keeps generating
      // tokens while the phone is already handling the next turn,
      // and both append into the same voice-session history.
      registerStreamAbort(user.id, "spar", abort);

      // Flush a zero-width space immediately + every ~2s while we wait
      // for the CLI to produce output. Cloudflare was closing the
      // origin connection and serving an HTML error page when the
      // first-byte gap stretched past ~10s during a tool-use loop.
      // Tightening this keeps the tunnel happy without changing what
      // the transcript or TTS sees (ZWSP is invisible).
      const KEEPALIVE = "​"; // zero-width space — invisible in transcript
      let lastFlushAt = Date.now();
      const flush = (text: string) => {
        lastFlushAt = Date.now();
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          /* stream closed */
        }
      };
      flush(KEEPALIVE);
      const keepaliveTimer = setInterval(() => {
        if (Date.now() - lastFlushAt >= 2_000) flush(KEEPALIVE);
      }, 1_000);

      // Accumulate the assistant's full reply so we can write it back
      // to the shared voice-session once the CLI finishes streaming.
      let replyBuffer = "";

      // Network blips and transient CLI failures used to surface as
      // "[error: claude cli exit=1]" and the user had to type "proceed"
      // to retry. Up to 3 attempts with a short backoff. We only retry
      // when nothing real has been streamed to the client yet — once
      // the user has seen partial tokens, retrying would duplicate
      // output, so we surface the error instead and keep the partial
      // reply (the finally block records it).
      const RETRY_DELAYS_MS = [0, 400, 1200];
      let realChunksEmitted = false;

      try {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
          if (abort.signal.aborted) {
            lastError = null;
            break;
          }
          if (RETRY_DELAYS_MS[attempt] > 0) {
            await new Promise<void>((r) =>
              setTimeout(r, RETRY_DELAYS_MS[attempt]),
            );
            if (abort.signal.aborted) {
              lastError = null;
              break;
            }
            replyBuffer = "";
          }
          try {
            await streamFromClaudeCli(
              {
                systemPrompt: autopilot
                  ? SPAR_SYSTEM_PROMPT + SPAR_AUTOPILOT_SUFFIX
                  : SPAR_SYSTEM_PROMPT,
                heartbeat,
                profile,
                history: msgs,
                model: SPAR_MODEL,
                signal: abort.signal,
                tools: {
                  token,
                  dashboardUrl,
                  allowedTools: SPAR_TOOLS,
                },
              },
              (chunk) => {
                realChunksEmitted = true;
                replyBuffer += chunk;
                flush(chunk);
              },
            );
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            if (abort.signal.aborted) break;
            if (realChunksEmitted) break;
            if (attempt < RETRY_DELAYS_MS.length - 1) {
              console.warn(
                `[spar] CLI failed (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}); retrying:`,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }

        if (lastError) {
          const msg =
            lastError instanceof Error ? lastError.message : String(lastError);
          console.warn("[spar] CLI error after retries:", msg);
          flush(`\n[error: ${msg.slice(0, 200)}]`);
        }
      } finally {
        clearInterval(keepaliveTimer);
        revokeToken(token);
        req.signal.removeEventListener("abort", onReqAbort);
        unregisterStreamAbort(user.id, "spar", abort);
        controller.close();
        // Always record the assistant turn so the dashboard transcript
        // and any future channel see the full reply. Even when the
        // phone took over mid-generation, the user wants the answer
        // they were waiting on — see remarks #70/#72. Hand the same
        // text to the Python /speak endpoint so the caller hears it
        // through the Telegram leg instead of the now-muted laptop.
        const sessionNow = getSession(user.id);
        const tookOver = sessionNow?.channel === "telegram";
        const reply = replyBuffer.replace(/​/g, "").trim();
        if (reply) {
          appendTurn(user.id, "spar", "assistant", reply);
        }
        if (tookOver && reply) {
          // Best-effort: the phone is the active output, but the
          // service may not be running (dev box without Python) or
          // may already be playing another utterance. Either way the
          // turn is in the session, so a future poll picks it up.
          // Don't await — finally must not block stream teardown,
          // and /speak's playback can take many seconds.
          void telegramSpeak({ text: reply }).catch((err: unknown) => {
            if (err instanceof TelegramVoiceUnavailable) {
              console.info(
                "[spar] handoff to telegram /speak skipped — service unreachable",
              );
            } else {
              console.warn(
                "[spar] handoff to telegram /speak failed:",
                err instanceof Error ? err.message : String(err),
              );
            }
          });
        }
        // Don't release if Telegram is now holding the line — the
        // phone owns the audio until /api/telegram/release flips it.
        if (!tookOver) releaseChannel(user.id);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
