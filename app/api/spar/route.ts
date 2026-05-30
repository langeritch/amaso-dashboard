import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCurrentUser } from "@/lib/auth";
import { readHeartbeat } from "@/lib/heartbeat";
import { readProfile } from "@/lib/user-profile";
import { loadBrainContext } from "@/lib/spar-brain";
import { streamFromClaudeCli, type SparMessage } from "@/lib/spar-claude";
import { streamFromAnthropicSdk } from "@/lib/spar-sdk";
import { streamFromGeminiCli } from "@/lib/spar-gemini";
import { mintToken, revokeToken } from "@/lib/spar-token";
import {
  SPAR_AUTOPILOT_SUFFIX,
  PLAYWRIGHT_TOOLS,
  SPAR_TOOLS,
  buildSparSystemPrompt,
} from "@/lib/spar-prompt";
import { buildAutopilotPromptBlock } from "@/lib/autopilot-prompt";
import { readAutopilotDirective } from "@/lib/autopilot";
import {
  formatGraphForPrompt,
  queryGraph,
} from "@/lib/knowledge-graph";
import {
  appendMessage as appendSparMessage,
  countAssistantMessages,
  createConversation as createSparConversation,
  getConversation as getSparConversation,
  getDailyConversation,
  getOrCreateDailyChat,
  getRecentMessages,
  setConversationTitle,
  setDriftNotice,
  smartDailyChatEnabled,
} from "@/lib/spar-conversations";
import {
  detectDrift,
  generateTitle,
  namingTrigger,
} from "@/lib/spar-conversation-naming";
import {
  attachAssistantInheritingFromUser,
  detectAndAttach as detectAndAttachTopic,
} from "@/lib/topic-detect";
import {
  buildTopicAwareWindow,
  smartTopicContextEnabled,
} from "@/lib/spar-topic-context";
import { broadcastSparConversation, broadcastSparMessage, broadcastSparStream } from "@/lib/ws";
import {
  activateChannel,
  appendTurn,
  getSession,
  registerStreamAbort,
  releaseChannel,
  unregisterStreamAbort,
} from "@/lib/voice-session";
import { speak as telegramSpeak, TelegramVoiceUnavailable } from "@/lib/telegram-voice";
import { getCurrentDestination } from "@/lib/audio-router";
import { streamTtsToCompanionUser } from "@/lib/companion-spar-relay";
import { matchSkillsForQuestion, formatSkillsForPrompt } from "@/lib/spar-skills";
import {
  BASELINE_SPAR_SOURCES,
  labelForToolUse,
  sourceForToolUse,
  summariseToolResult,
} from "@/lib/spar-tool-labels";
import { routeBrainUpdate } from "@/lib/spar-brain-autorouter";
import { routeAndLog } from "@/lib/spar-model-router";
import { isSmartTopicsEnabled } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });

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

  let body: {
    messages?: IncomingMessage[];
    autopilot?: boolean;
    attachments?: Array<{ name: string; type: string; dataUrl: string }>;
    /** Active spar conversation row id. The sidebar thread list
     *  drives this — when null, the route lazily creates one for the
     *  user (so brand-new sessions don't have to round-trip through
     *  /api/spar/conversations first) and emits the resulting id on
     *  the stream so the client can take ownership going forward. */
    conversationId?: number | null;
    /** Server-side directive that drives the assistant to respond to
     *  an event (e.g. "a dispatched task just finished — read the
     *  scrollback and summarise"). Surfaces to Claude as a final
     *  user-role turn prefixed `[system]` so the existing tool loop
     *  picks it up unchanged, but the dashboard renders no user
     *  bubble for it and we don't write it to the shared voice
     *  session — it isn't a real user utterance. */
    systemInjection?: string;
    /** Set by the auto-report responder when the latest user message
     *  in `messages` is already persisted (the synthetic "check output
     *  of terminal for X" nudge appended by terminal-idle.fireIdle).
     *  Skips the user-turn appendMessage block so we don't end up
     *  with two identical user rows in the conversation. */
    skipPersistLastUser?: boolean;
    /** Mobile-driven tweaks */
    model?: string;
    tone?: string;
    memory?: boolean;
    /** Topic scope for this turn. When set, the route fetches the
     *  topic's summary + last 5–10 tagged messages (owned by the
     *  calling user) and prepends them to the system prompt as a
     *  TOPIC SCOPE block. Mismatch on user ownership is silently
     *  ignored — the rest of the turn proceeds without the scope. */
    topicId?: number;
    /** Stable per-tab / per-installed-PWA id of the client that
     *  posted this request. Echoed back on every spar:stream WS
     *  broadcast so OTHER tabs of the same user know to mirror the
     *  stream live, while the originating client knows to ignore
     *  the mirror (it's already rendering locally from its own
     *  fetch). Optional for backwards compatibility — when absent
     *  no broadcasts go out and the request behaves like the
     *  pre-mirror single-client path. */
    originDeviceId?: string;
  } | null = null;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const history = Array.isArray(body?.messages) ? body!.messages : [];
  const autopilot = body?.autopilot === true;
  const rawAttachments = Array.isArray(body?.attachments) ? body!.attachments : [];

  // Empty-caption image-only sends: when the user uploaded a screenshot
  // without typing anything, the client's optimistic bubble has empty
  // content. Both the client-side historySnap filter and the msgs filter
  // below drop empty-content turns, which would silently strip the user
  // turn entirely — leaving the model with no fresh user message to
  // respond to and the screenshot anchored to nothing. Synthesize a
  // placeholder caption so the turn survives the filter, persists to
  // the conversation, and gives the model a clear instruction to look
  // at the image. Images are processed further down into temp files and
  // passed alongside via opts.images.
  if (rawAttachments.length > 0) {
    const hasImage = rawAttachments.some(
      (a) => typeof a?.type === "string" && a.type.startsWith("image/"),
    );
    if (hasImage) {
      const latest = history[history.length - 1];
      const latestIsEmptyUser =
        latest &&
        latest.role === "user" &&
        (typeof latest.content !== "string" || latest.content.trim().length === 0);
      if (!latest || latest.role !== "user") {
        history.push({
          role: "user",
          content: "Please look at the attached image(s).",
        });
      } else if (latestIsEmptyUser) {
        history[history.length - 1] = {
          ...latest,
          content: "Please look at the attached image(s).",
        };
      }
    }
  }
  const systemInjection =
    typeof body?.systemInjection === "string" ? body.systemInjection.trim() : "";
  const skipPersistLastUser = body?.skipPersistLastUser === true;
  const requestedTone = body?.tone;
  const requestedMemory = body?.memory !== false;
  const requestedModel = body?.model;
  // Live mirror identifiers. originDeviceId is the posting client's
  // stable tab id (browser sessionStorage for the dashboard,
  // localStorage for the PWA, the companion deviceId for the menu-bar
  // app). streamId is freshly minted per request so every NDJSON event
  // on this turn carries the same correlation key; mirror clients use
  // it to group events into a single assistant bubble even though the
  // mirrored content arrives interleaved with other ws traffic.
  const originDeviceId =
    typeof body?.originDeviceId === "string" && body.originDeviceId.length > 0
      ? body.originDeviceId.slice(0, 128)
      : null;
  const streamId =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  // Resolve / create the active conversation. The body's id is trusted
  // only after a per-user ownership check — otherwise a malicious
  // client could append into someone else's thread by guessing ids.
  // Lazy creation keeps the legacy "no-id" path working: the first
  // message of a fresh session lands in a brand-new conversation and
  // the assistant's reply pins the row to the user.
  const requestedConvId =
    typeof body?.conversationId === "number" && Number.isFinite(body.conversationId)
      ? body.conversationId
      : null;
  let conversationId: number | null = null;
  if (requestedConvId !== null) {
    const owned = getSparConversation(user.id, requestedConvId);
    // Reject task-owned conversations: those belong to the per-task
    // chat panel, not the main spar route. The main client never
    // sends those ids; this guard just makes sure a stale or
    // hand-rolled request can't append a main-chat turn into a
    // task thread.
    if (owned && owned.taskId == null) conversationId = owned.id;
  }
  let msgs: SparMessage[] = history
    .filter(
      (m): m is IncomingMessage =>
        !!m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .slice(-50);

  const heartbeat = readHeartbeat(user.id);
  const userProfile = readProfile(user.id);
  const brain = requestedMemory ? loadBrainContext(user) : { block: "", loaded: [] };
  let baseSystemPrompt = buildSparSystemPrompt(user.name);

  // Smart Topic System — final pass: inject the "Active topics today"
  // block right after the persona header so the assistant sees, on
  // every turn, which threads are in motion without having to call
  // list_topics. The block is empty (and therefore costs zero tokens)
  // when nothing has been tagged today — covers fresh days and
  // detector cold starts.
  //
  // Gated behind SMART_TOPICS_ENABLED (default off): when the flag is
  // off we add nothing to the prompt. The rollup data still exists in
  // the db — we just don't inject it. See isSmartTopicsEnabled().
  if (isSmartTopicsEnabled()) {
    try {
      const { formatActiveTopicsBlock } = await import("@/lib/daily-topic-rollup");
      const topicsBlock = formatActiveTopicsBlock(user.id);
      if (topicsBlock) {
        baseSystemPrompt += "\n\n" + topicsBlock;
      }
    } catch (err) {
      console.warn(
        "[spar] active-topics injection failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Topic-pill scope (from the composer's active topic). When the
  // client posts `topicId`, we fetch the topic + last ~10 tagged
  // messages and render a dedicated TOPIC SCOPE block so the model
  // can ground the turn against past conversation about exactly
  // that topic. Silently no-ops when the topic doesn't belong to
  // the calling user — the rest of the turn still goes through.
  const requestedTopicId =
    typeof body?.topicId === "number" && Number.isFinite(body.topicId) && body.topicId > 0
      ? body.topicId
      : null;
  // Gated behind SMART_TOPICS_ENABLED (default off): even when the
  // composer posts an active topic pill, skip the TOPIC SCOPE block
  // entirely while the flag is off. See isSmartTopicsEnabled().
  if (isSmartTopicsEnabled() && requestedTopicId !== null) {
    try {
      const { getTopicById, listMessagesForTopic } = await import("@/lib/topics");
      const topic = getTopicById(requestedTopicId);
      if (topic && topic.user_id === user.id) {
        const rows = listMessagesForTopic(topic.id, { limit: 10 });
        // listMessagesForTopic returns DESC; reverse to chronological.
        const chrono = rows.slice().reverse();
        const lines: string[] = [
          "=== TOPIC SCOPE ===",
          `The user has scoped this turn to topic: "${topic.title}" (slug: ${topic.slug}).`,
          `Topic summary: ${topic.summary ? topic.summary : "(none yet)"}`,
        ];
        if (chrono.length > 0) {
          lines.push("");
          lines.push("Recent messages tied to this topic (oldest first):");
          for (const m of chrono) {
            if (m.role !== "user" && m.role !== "assistant") continue;
            const stamp = new Date(m.created_at).toISOString().slice(0, 16).replace("T", " ");
            const body = m.content.length > 600
              ? m.content.slice(0, 600) + " …[truncated]"
              : m.content;
            lines.push(`[${m.role} ${stamp}] ${body.replace(/\s+/g, " ").trim()}`);
          }
        }
        lines.push("=== END TOPIC SCOPE ===");
        baseSystemPrompt += "\n\n" + lines.join("\n");
      }
    } catch (err) {
      console.warn(
        "[spar] topic-scope injection failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (requestedTone === "terse · honest") {
    baseSystemPrompt += "\n\nTONE: Be extremely terse, dry, and honest. No fluff. Minimum words needed to convey truth.";
  } else if (requestedTone === "detailed · helpful") {
    baseSystemPrompt += "\n\nTONE: Be proactive, detailed, and highly helpful. Think ahead for the user.";
  }

  // Layer 6.5 — tense-aware recall hint. Conservative regex over the
  // latest user message; if it fires AND the gates pass (prior day
  // exists in daily_chats, message isn't already topic-tagged
  // inline, the recall trigger is genuine), we append a soft hint to
  // the system prompt for THIS TURN ONLY. The model still decides
  // whether to actually call recall — the hint nudges, doesn't
  // execute. Audit row captures every fire so we can measure usefulness
  // later by joining model_called_recall.
  let tenseHintRowId: number | null = null;
  let modelCalledRecall = false;
  try {
    const latestUserText = (() => {
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m && m.role === "user" && typeof m.content === "string") return m.content;
      }
      return "";
    })();
    // Gate 1: don't double-up with the inline topic tagger.
    if (latestUserText && !/\[topics:\s*[\w-]/i.test(latestUserText)) {
      const { detectTenseHint, buildTenseHintBlock } = await import(
        "@/lib/spar-tense-hints"
      );
      const hint = detectTenseHint(latestUserText);
      if (hint) {
        // Gate 2: the user needs at least one prior day's chat for
        // recall to find anything. Day-1 users skip the hint.
        const { getDb } = await import("@/lib/db");
        const { todayLocalDate } = await import("@/lib/local-date");
        const priorDay = getDb()
          .prepare(
            `SELECT 1 FROM daily_chats
              WHERE user_id = ? AND date_local < ?
              LIMIT 1`,
          )
          .get(user.id, todayLocalDate());
        if (priorDay) {
          baseSystemPrompt += "\n\n" + buildTenseHintBlock(hint);
          try {
            const info = getDb()
              .prepare(
                `INSERT INTO tense_hint_invocations
                   (user_id, ts, matched_phrase, suggested_keyword, conversation_id, model_called_recall)
                 VALUES (?, ?, ?, ?, ?, 0)`,
              )
              .run(
                user.id,
                Date.now(),
                hint.matchedPhrase,
                hint.suggestedKeyword,
                conversationId ?? null,
              );
            tenseHintRowId = Number(info.lastInsertRowid);
          } catch (auditErr) {
            console.warn(
              "[spar] tense-hint audit insert failed:",
              auditErr instanceof Error ? auditErr.message : String(auditErr),
            );
          }
        }
      }
    }
  } catch (err) {
    console.warn(
      "[spar] tense-hint injection failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Auto-report turn detection. flushNudgeBatch (lib/terminal-idle.ts),
  // fireWorkerAutoReport (lib/worker-autoreport.ts), and
  // buildMergedAutoReportContent (components/SparProvider.tsx) all emit
  // synthetic user turns with one of these contract prefixes:
  //   • `Check terminal "<name>"…`   — autopilot ON nudge + worker
  //                                    autoreport pointer
  //   • `<name> is done. Autopilot is off — waiting on you.`
  //                                  — autopilot OFF nudge
  //   • `Check the output of terminal for …` — legacy wording, still
  //                                  matched so any in-flight bubbles
  //                                  from a pre-f72e45e build resolve.
  // When this turn fires UNDER AUTOPILOT, swap the generic suffix for
  // the rich autonomous-loop block (lib/autopilot-prompt.ts): tells
  // the model to evaluate each terminal, resolve any matching remark,
  // then orient on the directive / goals and dispatch the next move
  // without waiting for approval. Generic typed turns under autopilot
  // continue to use SPAR_AUTOPILOT_SUFFIX (handle gates, don't re-ask
  // about already-discussed dispatches) — the loop block is scoped to
  // the auto-report case so it doesn't bombard every regular reply.
  const latestUserContent =
    [...history].reverse().find((m) => m?.role === "user")?.content ?? "";
  const trimmedLatestUser = latestUserContent.trim();
  const isAutoReportTurn =
    /^check\s+terminal\s+"/i.test(trimmedLatestUser) ||
    /\bis done\.\s+autopilot is off\b/i.test(latestUserContent) ||
    /^check\s+(?:the\s+)?output\s+of\s+terminal[s]?\s+for\s+/i.test(trimmedLatestUser);
  console.log(
    `[spar] auto-report detection user=${user.id} autopilot=${autopilot} ` +
      `isAutoReportTurn=${isAutoReportTurn} ` +
      `latestUserHead=${JSON.stringify(trimmedLatestUser.slice(0, 80))}`,
  );
  const autopilotDirective =
    autopilot && isAutoReportTurn ? readAutopilotDirective(user.id) : "";
  const autopilotPromptAddon =
    autopilot && isAutoReportTurn
      ? buildAutopilotPromptBlock({ directive: autopilotDirective })
      : "";

  // Skills are matched off the most recent user turn(s) — workflow
  // playbooks the assistant should follow when the request matches.
  // No await on disk reads beyond the cached layer; matchSkillsForQuestion
  // never throws.
  const lastUserTurn =
    [...history].reverse().find((m) => m?.role === "user")?.content ?? "";
  const matchedSkills = matchSkillsForQuestion(lastUserTurn);
  const skillsBlock = formatSkillsForPrompt(matchedSkills);

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
    .slice(-10)
    .map((m) => m.content)
    .join(" ")
    .slice(0, 800);
  const keywords = recentUserText
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((w) => w.length >= 4);
  // Retry transient graph-read failures (e.g. a concurrent write
  // mid-rename) up to 3 times. queryGraph rarely throws — loadGraphSync
  // already swallows parse/read errors and returns an empty graph — so
  // a thrown error here usually means something genuinely unexpected
  // (locked file, fs permissions). We still log per attempt so a real
  // outage shows up clearly rather than masquerading as "no profile".
  let profile = "";
  const GRAPH_RETRY_DELAYS_MS = [0, 50, 150];
  let graphErr: unknown = null;
  for (let attempt = 0; attempt < GRAPH_RETRY_DELAYS_MS.length; attempt++) {
    if (GRAPH_RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise<void>((r) =>
        setTimeout(r, GRAPH_RETRY_DELAYS_MS[attempt]),
      );
    }
    try {
      const result = await queryGraph(user.id, { keywords, limit: 60 });
      profile = formatGraphForPrompt(result);
      graphErr = null;
      break;
    } catch (err) {
      graphErr = err;
      if (attempt < GRAPH_RETRY_DELAYS_MS.length - 1) {
        console.warn(
          `[spar] queryGraph failed (attempt ${attempt + 1}/${GRAPH_RETRY_DELAYS_MS.length}); retrying:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
  if (graphErr) {
    console.warn(
      "[spar] queryGraph failed after retries — continuing without profile:",
      graphErr instanceof Error ? graphErr.message : String(graphErr),
    );
  }

  // Empty history → treat as the kickoff greeting. Seed a silent user
  // turn that tells Haiku to open the conversation itself. Skipped
  // when a systemInjection was supplied — that's already a directive
  // for what to say, no need for a kickoff greeting on top.
  if (msgs.length === 0 && !systemInjection) {
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

  // Conversation persistence. The latest user turn lands in
  // spar_messages now (so a refresh mid-thinking already has it in
  // history), and the conversation is created lazily on the first
  // real turn so empty greeting-only kickoffs don't litter the
  // sidebar with placeholder rows.
  const latestForPersist = msgs[msgs.length - 1];
  const persistableUser =
    !skipPersistLastUser &&
    latestForPersist &&
    latestForPersist.role === "user" &&
    !latestForPersist.content.startsWith("[kickoff]") &&
    !latestForPersist.content.startsWith("[system]");
  if (persistableUser) {
    // Layer 3 (SMART_DAILY_CHAT): a new turn always lands in today's
    // active daily chat regardless of which conversation the client
    // had selected. The client receives the canonical id back via the
    // `{t:"conversation",id}` event below and re-hydrates if needed.
    // Legacy mode keeps the per-session create-on-first-message path.
    if (smartDailyChatEnabled()) {
      const daily = getOrCreateDailyChat(user.id);
      conversationId = daily.id;
    } else if (conversationId === null) {
      const daily = getDailyConversation(user.id);
      if (daily) {
        conversationId = daily.id;
      } else {
        const conv = createSparConversation(user.id, null);
        conversationId = conv.id;
      }
    }
    const userRow = appendSparMessage({
      conversationId,
      userId: user.id,
      role: "user",
      content: latestForPersist.content,
    });
    if (userRow) {
      try {
        broadcastSparMessage(user.id, {
          conversationId: userRow.conversationId,
          message: {
            id: userRow.id,
            role: userRow.role,
            content: userRow.content,
            toolCalls: userRow.toolCalls,
            createdAt: userRow.createdAt,
          },
        });
      } catch {
        /* broadcast failure is non-fatal */
      }
      // Layer 1 topic detection — fire-and-forget so a slow Haiku call
      // can't delay the streaming response. Failures are swallowed
      // inside detectAndAttach.
      void detectAndAttachTopic(user.id, userRow.id, userRow.content).catch(() => {
        /* swallow */
      });
    }
  }

  // Append the system injection AFTER the voice-session sync above so
  // it never lands in shared session memory — phone callers shouldn't
  // see "[system] task finished, summarise…" turns when they scroll
  // back, only the assistant's natural-language summary that follows.
  // The `[system]` prefix mirrors the `[kickoff]` convention: Claude
  // treats the directive as the latest user turn and the existing
  // tool loop kicks in (read_terminal_scrollback etc.) without any
  // route-level branching.
  if (systemInjection) {
    msgs.push({ role: "user", content: `[system] ${systemInjection}` });
  }

  interface ProcessedAttachment {
    name: string;
    type: string;
    imagePath?: string;
    textContent?: string;
  }
  const processedAttachments: ProcessedAttachment[] = [];
  let attachmentTmpDir: string | null = null;
  // Files we can't pass through the CLI as text-or-images get a
  // structured placeholder so the model knows the user attached them
  // (so it can ask for an alternative or do something useful with the
  // metadata) without choking on raw binary bytes decoded as UTF-8.
  const isTextLike = (mime: string, name: string): boolean => {
    if (mime.startsWith("text/")) return true;
    if (mime === "application/json" || mime === "application/xml") return true;
    if (mime === "application/csv" || mime === "application/x-csv") return true;
    // Office docs and zips claim text-ish MIMEs but are binary; key off
    // extension as the tiebreaker for clients that send octet-stream.
    if (mime === "application/octet-stream") {
      const ext = name.toLowerCase().split(".").pop() ?? "";
      if (["txt", "md", "csv", "tsv", "json", "xml", "yml", "yaml", "log"].includes(ext)) {
        return true;
      }
    }
    return false;
  };
  if (rawAttachments.length > 0) {
    attachmentTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spar-att-"));
    for (const att of rawAttachments) {
      if (!att?.dataUrl || !att?.name || !att?.type) continue;
      const dataUrl = att.dataUrl as string;
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;
      const buf = Buffer.from(match[2], "base64");
      if (att.type.startsWith("image/")) {
        const ext = att.name.split(".").pop() || "png";
        const tmpPath = path.join(attachmentTmpDir, `${processedAttachments.length}.${ext}`);
        fs.writeFileSync(tmpPath, buf);
        processedAttachments.push({ name: att.name, type: att.type, imagePath: tmpPath });
      } else if (isTextLike(att.type, att.name)) {
        const text = buf.toString("utf-8").slice(0, 50_000);
        processedAttachments.push({ name: att.name, type: att.type, textContent: text });
      } else {
        // PDFs, spreadsheets, archives, etc. The CLI has no document
        // content-block flag (the Anthropic API does, but we shell out
        // to claude --print). Surface metadata so the model can react.
        const sizeKb = Math.round(buf.byteLength / 1024);
        const note = `(binary file — ${att.type || "unknown type"}, ${sizeKb} KB; content not extracted)`;
        processedAttachments.push({ name: att.name, type: att.type, textContent: note });
      }
    }
  }
  const imageAttachments = processedAttachments
    .filter((a) => a.imagePath)
    .map((a) => ({ path: a.imagePath!, type: a.type, name: a.name }));
  const textAttachmentBlock = processedAttachments
    .filter((a) => a.textContent)
    .map((a) => `=== Attached file: ${a.name} ===\n${a.textContent}\n=== End ${a.name} ===`)
    .join("\n\n");
  // The CLI reads images off disk (their paths are inlined into the
  // prompt). Deleting the temp dir as soon as the stream closes would
  // race the model's Read tool calls — leave the files around for 5
  // minutes and let the OS / next request clean up.
  const ATTACHMENT_TTL_MS = 5 * 60 * 1000;
  const cleanupAttachments = () => {
    if (!attachmentTmpDir) return;
    const dir = attachmentTmpDir;
    setTimeout(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, ATTACHMENT_TTL_MS).unref?.();
  };

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

      // Wire protocol: newline-delimited JSON. Each line is one event:
      //   {"t":"text","v":"..."}              — visible assistant text
      //   {"t":"tool_use","id":"...",...}     — agent kicked off a tool call
      //   {"t":"tool_result","id":"...",...}  — that call just returned
      //   {"t":"ping"}                        — keepalive (keeps Cloudflare happy)
      //   {"t":"error","v":"..."}             — terminal CLI failure
      // The client (SparProvider.sendMessage) parses line-by-line and
      // routes to either the assistant message body or the tool-step
      // list. We need NDJSON instead of raw text because feature 2
      // wants tool events visualised in the chat — embedding sentinel
      // tokens in a plaintext stream gets messy fast.
      let lastFlushAt = Date.now();
      const sendEvent = (evt: Record<string, unknown>) => {
        lastFlushAt = Date.now();
        try {
          controller.enqueue(enc.encode(JSON.stringify(evt) + "\n"));
        } catch {
          /* stream closed */
        }
        // Live mirror: fan out the same NDJSON event to every other
        // socket the user has open so passive clients can follow the
        // turn token-by-token. Only fires when the caller identified
        // itself with an originDeviceId — legacy callers (no device
        // id) keep the pre-mirror single-client behaviour. Ping
        // events are kept out of the mirror to avoid burning ws
        // bandwidth on 1Hz keepalives that have no visual effect on
        // the receiver.
        if (originDeviceId && evt.t !== "ping") {
          try {
            broadcastSparStream(user.id, {
              conversationId,
              originDeviceId,
              streamId,
              event: evt,
            });
          } catch {
            /* broadcast is best-effort — never let a ws hiccup block
               the actual stream to the requesting client */
          }
        }
      };
      // Open with a ping so Cloudflare gets bytes immediately and the
      // client knows the stream is alive even before the CLI warms up.
      sendEvent({ t: "ping" });
      // Surface the active conversation id once: lets the client
      // hydrate the sidebar's "selected" highlight on the first turn
      // of a fresh session (where the row was just lazily created
      // server-side and the client doesn't know its id yet).
      if (conversationId !== null) {
        sendEvent({ t: "conversation", id: conversationId });
      }
      // Tell the client up-front which sources are guaranteed in the
      // prompt. The CLI hasn't even started yet, but heartbeat / user
      // profile / matched skills / CLAUDE.md / MEMORY.md are already
      // baked in by the prompt builder. The UI uses this as the
      // baseline of the "sources read" strip on the assistant message
      // — tool calls during the turn append more sources on top.
      sendEvent({
        t: "sources",
        v: [...BASELINE_SPAR_SOURCES, ...brain.loaded],
      });
      const keepaliveTimer = setInterval(() => {
        if (Date.now() - lastFlushAt >= 2_000) sendEvent({ t: "ping" });
      }, 1_000);

      // Accumulate the assistant's full reply (text events only) so
      // the finally block can persist it to the voice session.
      let replyBuffer = "";
      // Snapshot of every tool the assistant fired during the turn.
      // Persisted alongside the assistant message so a different
      // device hydrating this thread sees the same step cards as the
      // tab that originated the turn.
      type PersistedToolStep = {
        id: string;
        name: string;
        label: string;
        detail: string;
        source: string | null;
        status: "running" | "ok" | "error";
        summary: string;
      };
      const toolSteps: PersistedToolStep[] = [];

      // Network blips and transient CLI failures used to surface as
      // "[error: claude cli exit=1]" and the user had to type "proceed"
      // to retry. Up to 3 attempts with a short backoff. We only retry
      // when nothing real has been streamed to the client yet — once
      // the user has seen text or tool steps, retrying would duplicate
      // output, so we surface the error instead and keep the partial
      // reply (the finally block records it).
      const RETRY_DELAYS_MS = [0, 400, 1200];
      let realEventsEmitted = false;

      // Layer 2 (Smart Topic System): augment the LLM window with older
      // messages from the same topic as the latest user turn. Cheap-
      // only matcher — no model round-trip on the request path. When
      // disabled or when no topic matches cleanly, `effectiveMsgs`
      // collapses to the recency-only `msgs` we'd have sent before —
      // a plain message window with no inline `[topics: ...]` tags.
      //
      // Gated behind the SMART_TOPICS_ENABLED master flag (default
      // off): when off, layer2 is null and effectiveMsgs === msgs, so
      // no topic annotations and no topic-linked brain block are added.
      const layer2Enabled = isSmartTopicsEnabled() && smartTopicContextEnabled();
      const layer2 = layer2Enabled
        ? buildTopicAwareWindow({
            userId: user.id,
            conversationId,
            currentMessageText: latestUserContent,
            recentMessages: msgs,
            maxMessages: 50,
          })
        : null;
      const effectiveMsgs = layer2?.messages ?? msgs;
      if (layer2?.fired) {
        console.log(
          `[spar-topic-context] topic=${layer2.topicSlug ?? "?"} ` +
            `topic-pulled=${layer2.topicMessages} recency=${layer2.recencyMessages} ` +
            `final=${layer2.messages.length}`,
        );
      }
      // Layer 7: append topic-linked brain sections to the existing
      // brain block so they ride in under the same BRAIN / MEMORY
      // header in the prompt. Empty string when the flag is off or the
      // matched topic has no refs that resolved.
      const layer7Block = layer2?.brainBlock ?? "";
      if (layer2?.brainRefsInjected) {
        console.log(
          `[spar-topic-brain] topic=${layer2.topicSlug ?? "?"} ` +
            `refs=${layer2.brainRefsInjected} chars=${layer2.brainCharsInjected}`,
        );
      }
      const effectiveBrainBlock = layer7Block
        ? brain.block
          ? `${brain.block}\n\n${layer7Block}`
          : layer7Block
        : brain.block;

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
            const historyWithAttachments = textAttachmentBlock
              ? [
                  ...effectiveMsgs.slice(0, -1),
                  {
                    ...effectiveMsgs[effectiveMsgs.length - 1],
                    content:
                      effectiveMsgs[effectiveMsgs.length - 1].content +
                      "\n\n" +
                      textAttachmentBlock,
                  },
                ]
              : effectiveMsgs;

            // Layer 2 routing. The router inspects only the latest
            // user message (autopilot flag + auto-report detection
            // come from this turn). Decision is logged on every
            // attempt so the audit jsonl shows retries too.
            const routeDecision = routeAndLog({
              source: "api/spar",
              message: latestUserContent,
              autopilot,
              requestedModel,
              conversationId,
              userId: user.id,
              hasImages: imageAttachments.length > 0,
            });

            const sparOpts = {
              systemPrompt: autopilot
                ? autopilotPromptAddon
                  ? baseSystemPrompt +
                    SPAR_AUTOPILOT_SUFFIX +
                    "\n\n" + autopilotPromptAddon
                  : baseSystemPrompt + SPAR_AUTOPILOT_SUFFIX
                : baseSystemPrompt,
              heartbeat,
              profile,
              userProfile,
              skills: skillsBlock,
              brain: effectiveBrainBlock,
              history: historyWithAttachments,
              model: routeDecision.model,
              signal: abort.signal,
              images: imageAttachments.length > 0 ? imageAttachments : undefined,
              tools: {
                token,
                dashboardUrl,
                // SMART_TOPICS_ENABLED master flag (default off): when
                // off, drop `list_topics` from the tool list sent to the
                // model so it isn't offered the topic-listing tool. The
                // canonical SPAR_TOOLS list is left intact; we only
                // filter at the point of use. Handler is also guarded.
                allowedTools: isSmartTopicsEnabled()
                  ? SPAR_TOOLS
                  : SPAR_TOOLS.filter((t) => t !== "list_topics"),
                allowedPlaywrightTools: PLAYWRIGHT_TOOLS,
              },
            };

            const useAnthropicSdk =
              !sparOpts.model.startsWith("gemini") &&
              !!process.env.AMASO_SPAR_ANTHROPIC_KEY;

            const streamFn = sparOpts.model.startsWith("gemini")
              ? streamFromGeminiCli
              : useAnthropicSdk
                ? null
                : streamFromClaudeCli;

            const streamHandlers = {
              onText: (chunk: string) => {
                realEventsEmitted = true;
                replyBuffer += chunk;
                sendEvent({ t: "text", v: chunk });
              },
              onToolUse: (e: { id: string; name: string; input: unknown }) => {
                realEventsEmitted = true;
                // Layer 6.5: flag the in-flight tense-hint audit row
                // when the model actually decides to invoke recall.
                // Wire is local-scope so this matches the hint that
                // was injected at the top of this very turn.
                if (e.name === "recall" || e.name === "mcp__spar__recall") {
                  modelCalledRecall = true;
                }
                const { label, detail } = labelForToolUse(e.name, e.input);
                const source = sourceForToolUse(e.name, e.input);
                toolSteps.push({
                  id: e.id,
                  name: e.name,
                  label,
                  detail,
                  source,
                  status: "running",
                  summary: "",
                });
                sendEvent({
                  t: "tool_use",
                  id: e.id,
                  name: e.name,
                  label,
                  detail,
                  source,
                });
              },
              onToolResult: (e: { id: string; ok: boolean; content: string }) => {
                realEventsEmitted = true;
                const summary = summariseToolResult(e.content, e.ok);
                const idx = toolSteps.findIndex((s) => s.id === e.id);
                if (idx >= 0) {
                  toolSteps[idx] = {
                    ...toolSteps[idx],
                    status: e.ok ? "ok" : "error",
                    summary,
                  };
                }
                sendEvent({
                  t: "tool_result",
                  id: e.id,
                  ok: e.ok,
                  summary,
                });
              },
            };

            // Both backends emit CUMULATIVE running totals on every
            // onUsage call (CLI: closure-wrapped in lib/spar-claude.ts;
            // SDK: accumulated across turns in lib/spar-sdk.ts). The
            // route just forwards each snapshot to the client so the
            // badge shows the latest values without us doing math here.
            let lastUsageSeen = {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            };
            const emitUsage = (u: {
              inputTokens: number;
              outputTokens: number;
              cacheCreationTokens: number;
              cacheReadTokens: number;
            }) => {
              lastUsageSeen = u;
              sendEvent({
                t: "usage",
                v: {
                  input: u.inputTokens,
                  output: u.outputTokens,
                  cacheCreation: u.cacheCreationTokens,
                  cacheRead: u.cacheReadTokens,
                  model: routeDecision.model,
                  tier: routeDecision.tier,
                },
              });
            };

            if (useAnthropicSdk) {
              await streamFromAnthropicSdk(sparOpts, streamHandlers, emitUsage);
            } else {
              await streamFn!(
                sparOpts,
                { ...streamHandlers, onUsage: emitUsage },
              );
              // Guarantee at least one usage event even when the
              // backend emitted nothing parseable (e.g. Gemini, or an
              // older Claude CLI with no usage in the stream): the
              // badge still needs to know which tier handled the turn.
              if (
                lastUsageSeen.inputTokens === 0 &&
                lastUsageSeen.outputTokens === 0 &&
                lastUsageSeen.cacheCreationTokens === 0 &&
                lastUsageSeen.cacheReadTokens === 0
              ) {
                sendEvent({
                  t: "usage",
                  v: {
                    input: 0,
                    output: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                    model: routeDecision.model,
                    tier: routeDecision.tier,
                  },
                });
              }
            }
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            if (abort.signal.aborted) break;
            if (realEventsEmitted) break;
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
          if (realEventsEmitted && replyBuffer.trim()) {
            // CLI crashed mid-stream but we already sent real content.
            // Swallow the error — partial reply is better than an error
            // card on top of text the user already read.
            console.warn("[spar] CLI crashed mid-stream but reply delivered; swallowing:", msg);
          } else {
            console.warn("[spar] CLI error after retries:", msg);
            sendEvent({ t: "error", v: msg.slice(0, 200) });
          }
        }
      } finally {
        clearInterval(keepaliveTimer);
        revokeToken(token);
        cleanupAttachments();
        req.signal.removeEventListener("abort", onReqAbort);
        unregisterStreamAbort(user.id, "spar", abort);
        // Finish sentinel — mirror clients use this to flip their
        // streaming bubble's `streaming:false` flag. The originating
        // client also receives it (no-op on its side; its existing
        // reader.read()→done flow already finalises the bubble).
        // Wrapped in try/catch because the controller may already be
        // closed if the originating client disconnected mid-stream.
        try { sendEvent({ t: "finish" }); } catch { /* already closed */ }
        controller.close();
        // Layer 6.5 — back-fill the tense-hint audit row with the
        // model's actual recall behaviour for this turn. Lets us
        // measure whether the hint pulled its weight by joining
        // tense_hint_invocations WHERE model_called_recall = 1.
        if (tenseHintRowId !== null && modelCalledRecall) {
          try {
            const { getDb } = await import("@/lib/db");
            getDb()
              .prepare(
                "UPDATE tense_hint_invocations SET model_called_recall = 1 WHERE id = ?",
              )
              .run(tenseHintRowId);
          } catch (err) {
            console.warn(
              "[spar] tense-hint backfill failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        // Always record the assistant turn so the dashboard transcript
        // and any future channel see the full reply. Even when the
        // phone took over mid-generation, the user wants the answer
        // they were waiting on — see remarks #70/#72. Hand the same
        // text to the Python /speak endpoint so the caller hears it
        // through the Telegram leg instead of the now-muted laptop.
        const sessionNow = getSession(user.id);
        const tookOver = sessionNow?.channel === "telegram";
        const reply = replyBuffer.trim();
        if (reply) {
          appendTurn(user.id, "spar", "assistant", reply);
          // Mirror the assistant turn into the persistent
          // conversation. Skipped if no conversation exists (e.g. the
          // user never hit the persistence path — kickoff-only or
          // pure system-injection turns) so the sidebar list stays
          // honest about which threads have user-visible content.
          if (conversationId !== null) {
            try {
              const assistantRow = appendSparMessage({
                conversationId,
                userId: user.id,
                role: "assistant",
                content: reply,
                toolCalls: toolSteps.length > 0 ? toolSteps : null,
              });
              if (assistantRow) {
                broadcastSparMessage(user.id, {
                  conversationId: assistantRow.conversationId,
                  // Tag the persisted-row broadcast with the same
                  // streamId the live mirror events used so passive
                  // clients can adopt the assistant id onto the
                  // streaming bubble they already rendered instead
                  // of inserting a duplicate.
                  streamId: originDeviceId ? streamId : undefined,
                  message: {
                    id: assistantRow.id,
                    role: assistantRow.role,
                    content: assistantRow.content,
                    toolCalls: assistantRow.toolCalls,
                    createdAt: assistantRow.createdAt,
                  },
                });
                // Layer 5 fix: copy the prior user message's topic
                // attachments onto this assistant row so the topic
                // detail view shows the full thread. Idempotent and
                // silent on failure. The reverse race (user-detection
                // finishes after assistant persists) is covered by
                // mirrorTopicsToFollowingAssistant inside detectAndAttach.
                attachAssistantInheritingFromUser(assistantRow.id);
                // Fire-and-forget brain auto-router: scan the assistant
                // reply for structured facts (decisions, lessons, shipped
                // items, goal statements) and append them to the appropriate
                // brain markdown files. Never blocks the response.
                void routeBrainUpdate(
                  user.id,
                  (Array.isArray(assistantRow.content)
                    ? assistantRow.content
                        .map((b: unknown) =>
                          typeof b === "string"
                            ? b
                            : (b as { text?: string })?.text ?? "",
                        )
                        .join("")
                    : String(assistantRow.content ?? "")),
                  assistantRow.conversationId,
                ).catch(() => {});
                // Fire-and-forget auto-naming. Lives entirely outside
                // the request lifecycle: the stream has already
                // closed at this point, so a slow Haiku turn here
                // costs the user nothing. Any failure logs and
                // moves on — naming is best-effort.
                void runAutoNaming(user.id, assistantRow.conversationId).catch(
                  (err: unknown) => {
                    console.warn(
                      "[spar] auto-naming failed:",
                      err instanceof Error ? err.message : String(err),
                    );
                  },
                );
              }
            } catch (err) {
              console.warn(
                "[spar] failed to persist assistant message:",
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
        if (reply) {
          // Audio-router-driven TTS routing. Resolve the destination
          // at finally-time so a mid-turn flip (telegram acquired
          // while we were thinking) lands the spoken reply on the
          // correct transport.
          const dest = getCurrentDestination(user.id);
          if (dest === "telegram") {
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
          } else if (dest === "companion") {
            void streamTtsToCompanionUser(user.id, reply).catch((err: unknown) => {
              console.warn(
                "[spar] handoff to companion TTS failed:",
                err instanceof Error ? err.message : String(err),
              );
            });
          }
          // dashboard: NDJSON text events already streamed to the
          // browser; the browser plays its own TTS.
          void tookOver;
        }
        // Don't release if Telegram is now holding the line — the
        // phone owns the audio until /api/telegram/release flips it.
        if (!tookOver) releaseChannel(user.id);
      }
    },
  });

  return new Response(stream, {
    headers: {
      // application/x-ndjson — one JSON object per line, see the
      // wire protocol comment above. Browsers don't render this any
      // differently than text/plain, but the explicit type makes
      // misuse (cat-ing through a non-streaming proxy) easier to
      // diagnose.
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Background auto-naming + drift detection. Runs after the assistant
 * turn has been persisted; fires a Haiku one-shot to (re-)name the
 * thread and broadcasts the result over the existing per-user WS
 * channel. Trigger windows (see namingTrigger):
 *
 *   - Assistant message #1, #2, #3 → re-evaluate the title each
 *     turn so the sidebar settles on a clean topic as the
 *     conversation crystallises.
 *   - Every 10 turns thereafter → drift check. Haiku decides whether
 *     the topic has wandered and, if it's wandered far enough,
 *     suggests a fresh chat.
 *
 * Never throws to the caller — every failure is logged and
 * swallowed. The streaming endpoint awaits nothing here.
 */
async function runAutoNaming(userId: number, conversationId: number): Promise<void> {
  const conv = getSparConversation(userId, conversationId);
  if (!conv) return;
  const count = countAssistantMessages(conversationId);
  const trigger = namingTrigger(count);
  if (!trigger) return;
  // Idempotency guard: lastNamedAtCount is bumped to `count` on
  // every successful rename, so a duplicate trigger (two tabs
  // racing on the same persist) becomes a no-op.
  if (conv.lastNamedAtCount === count) return;

  if (trigger.kind === "rename") {
    const recent = getRecentMessages(conversationId, 8);
    if (recent.length === 0) return;
    const title = await generateTitle(recent);
    if (!title || title === conv.title) return;
    const updated = setConversationTitle(userId, conversationId, title, count);
    if (!updated) return;
    broadcastSparConversation(userId, {
      conversationId,
      title: updated.title,
      updatedAt: updated.updatedAt,
    });
    return;
  }

  // Drift check: only useful once we have a real title to compare
  // against. If the user (or an earlier rename pass) hasn't named
  // the thread yet, fall back to a fresh title pass instead.
  const baselineTitle = (conv.title ?? "").trim();
  if (!baselineTitle) {
    const recent = getRecentMessages(conversationId, 6);
    const title = await generateTitle(recent);
    if (!title || title === conv.title) return;
    const updated = setConversationTitle(userId, conversationId, title, count);
    if (!updated) return;
    broadcastSparConversation(userId, {
      conversationId,
      title: updated.title,
      updatedAt: updated.updatedAt,
    });
    return;
  }

  const recent = getRecentMessages(conversationId, 6);
  const verdict = await detectDrift(baselineTitle, recent);
  if (!verdict) return;

  let titleChanged = false;
  let driftChanged = false;
  let updatedAt = conv.updatedAt;

  if (verdict.drifted && verdict.newTitle && verdict.newTitle !== conv.title) {
    const updated = setConversationTitle(userId, conversationId, verdict.newTitle, count);
    if (updated) {
      titleChanged = true;
      updatedAt = updated.updatedAt;
    }
  }

  const desiredNotice =
    verdict.shouldSplit && verdict.splitReason
      ? verdict.splitReason
      : verdict.shouldSplit
        ? "This chat has drifted from its original topic. Consider starting a new chat for better organization."
        : null;
  if (desiredNotice !== conv.driftNotice) {
    const updated = setDriftNotice(userId, conversationId, desiredNotice);
    if (updated) {
      driftChanged = true;
      updatedAt = updated.updatedAt;
    }
  }

  if (!titleChanged && !driftChanged) return;
  broadcastSparConversation(userId, {
    conversationId,
    ...(titleChanged ? { title: verdict.newTitle } : {}),
    ...(driftChanged ? { driftNotice: desiredNotice } : {}),
    updatedAt,
  });
}
