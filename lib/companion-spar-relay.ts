/**
 * Companion sparring-partner relay.
 *
 * The macOS / Windows menu-bar companion is a thin client. It records
 * mic audio (or sends typed text) over the existing companion WS,
 * the dashboard does ALL the heavy lifting (Whisper transcription,
 * LLM call, Kokoro TTS), and streams results back. Same conversation
 * the browser spar uses, so the user can move from typing in the
 * browser to speaking on the companion mid-thread without the agent
 * losing context.
 *
 * Wire protocol (see spec):
 *   companion -> dashboard
 *     spar.text          { text }
 *     spar.audio.start   {}
 *     spar.audio.chunk   { data: <base64 PCM 16k mono s16le> }
 *     spar.audio.stop    {}
 *     spar.state.request {}
 *
 *   dashboard -> companion
 *     spar.state                { state: "idle"|"listening"|"thinking"|"speaking" }
 *     spar.transcript           { text }
 *     spar.text.response        { text, final }
 *     spar.audio.response       { data: <base64 audio chunk> }
 *     spar.audio.response.end   {}
 *
 * State machine per device:
 *   idle           start typing or hit record
 *   listening      audio.start landed, chunks coming in, stop pending
 *   thinking       transcript or text in hand, LLM is generating
 *   speaking       LLM done, TTS chunks streaming out
 *   idle           audio.response.end fired, ready for the next turn
 */

import { collectFromClaudeCli, type SparMessage } from "./spar-claude";
import { readHeartbeat } from "./heartbeat";
import { readProfile } from "./user-profile";
import { loadBrainContext } from "./spar-brain";
import {
  appendMessage as appendSparMessage,
  createConversation as createSparConversation,
  getConversation as getSparConversation,
  getRecentMessages,
  latestConversationId,
  listConversations,
} from "./spar-conversations";
import { broadcastSparMessage } from "./ws";
import { SPAR_MODEL, buildSparSystemPrompt } from "./spar-prompt";
import { transcribePcm } from "./whisper-bridge";
import { getKokoroPort } from "./kokoro";
import { visibleProjects, canAccessProject } from "./access";
import { listSessionsForProject } from "./terminal-backend";
import { detectWorkerState, STATE_TAIL_BYTES } from "./terminal-state";
import { recentDispatches } from "./spar-dispatch";
import { getDb } from "./db";
import type { User } from "./db";

const RELAY_HISTORY_LIMIT = 30;
// 64 KB base64 chunks. Keeps each spar.audio.response frame under ~85
// KB on the wire while still letting the companion start playback
// after the first chunk lands. Tweak with AMASO_COMPANION_TTS_CHUNK
// if a slow uplink benefits from smaller frames.
const TTS_CHUNK_BYTES = Math.max(
  4_096,
  Number(process.env.AMASO_COMPANION_TTS_CHUNK ?? "65536"),
);
// Default sample rate the companion sends for mic audio. Companion
// docs spec 16 kHz mono s16le; the Python /transcribe endpoint
// resamples if a different rate is supplied via the buffer header.
const COMPANION_PCM_SAMPLE_RATE = Math.max(
  8_000,
  Number(process.env.AMASO_COMPANION_PCM_RATE ?? "16000"),
);

export type SparRelayState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking";

export type CompanionToSparMessage =
  | { type: "spar.text"; text?: unknown; conversationId?: unknown }
  | { type: "spar.audio.start" }
  | { type: "spar.audio.chunk"; data?: unknown }
  | { type: "spar.audio.stop"; conversationId?: unknown }
  | { type: "spar.state.request" }
  | {
      type: "spar.history.request";
      conversationId?: unknown;
      limit?: unknown;
    }
  | { type: "spar.conversations.list" }
  | { type: "spar.workers.request" }
  | { type: "spar.workers.subscribe" }
  | {
      type: "spar.tasks.request";
      resolved?: unknown;
      tag?: unknown;
      limit?: unknown;
    }
  | { type: "spar.tasks.subscribe" };

export interface CompanionHistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** ISO 8601 timestamp string. */
  timestamp: string;
}

export interface CompanionConversationSummary {
  id: string;
  title?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  messageCount: number;
}

export interface CompanionWorkerSummary {
  projectId: string;
  name: string;
  status: "idle" | "working" | "done" | "error";
  lastActivity?: string;
  lastDispatch?: string;
}

export interface CompanionTaskSummary {
  id: string;
  text: string;
  tag?: string;
  resolved: boolean;
  projectId?: string;
  createdAt: string;
}

export type SparToCompanionMessage =
  | { type: "spar.state"; state: SparRelayState }
  | { type: "spar.transcript"; text: string }
  | { type: "spar.text.response"; text: string; final: boolean }
  | { type: "spar.audio.response"; data: string }
  | { type: "spar.audio.response.end" }
  | {
      type: "spar.history.response";
      conversationId: string;
      messages: CompanionHistoryMessage[];
    }
  | {
      type: "spar.conversations.response";
      conversations: CompanionConversationSummary[];
    }
  | { type: "spar.workers.response"; workers: CompanionWorkerSummary[] }
  | { type: "spar.workers.update"; worker: CompanionWorkerSummary }
  | { type: "spar.tasks.response"; tasks: CompanionTaskSummary[] }
  | { type: "spar.tasks.update"; task: CompanionTaskSummary };

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 500;
const CONVERSATIONS_LIST_LIMIT = 100;

/** Per-device state. Lives on the companion-ws ClientState; this
 *  module just owns the shape and the helpers that mutate it. */
export interface CompanionSparState {
  /** UI-facing relay state. Drives the companion's circle UI. */
  state: SparRelayState;
  /** Active audio buffer when state === "listening". Chunks land here
   *  until spar.audio.stop. */
  audioChunks: Buffer[];
  audioBytes: number;
  audioStartedAt: number | null;
  /** True while a turn is mid-flight (transcribe or LLM or TTS). Used
   *  to drop accidental double-sends. */
  busy: boolean;
  /** Workers subscription. When non-null, a poll timer is running and
   *  diffing snapshots; resetSparState clears the timer on close. */
  workersTimer: NodeJS.Timeout | null;
  /** Last serialised worker payload per projectId, used to suppress
   *  spar.workers.update emissions when nothing actually changed
   *  between polls. */
  workersLastSent: Map<string, string>;
  /** Tasks subscription. The unsubscribe handle returned by
   *  registerTaskListener; cleared on close. */
  tasksUnsub: (() => void) | null;
}

export function newCompanionSparState(): CompanionSparState {
  return {
    state: "idle",
    audioChunks: [],
    audioBytes: 0,
    audioStartedAt: null,
    busy: false,
    workersTimer: null,
    workersLastSent: new Map(),
    tasksUnsub: null,
  };
}

export type SparRelaySender = (msg: SparToCompanionMessage) => void;

interface HandleContext {
  user: User;
  state: CompanionSparState;
  send: SparRelaySender;
}

function setState(ctx: HandleContext, next: SparRelayState): void {
  if (ctx.state.state === next) return;
  ctx.state.state = next;
  try {
    ctx.send({ type: "spar.state", state: next });
  } catch {
    /* socket may have closed; the close handler will clean up */
  }
}

/** Parse a conversation id off the wire. The companion sends them as
 *  strings (JSON-friendly) but spar_messages keys on integers, so we
 *  coerce + validate here. Returns null on anything non-numeric so
 *  the caller can fall back to the latest conversation. */
function parseConversationId(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  return null;
}

function deriveConversationTitle(
  explicit: string | null,
  preview: string | null,
  createdAt: number,
): string {
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim().slice(0, 60);
  }
  if (preview && preview.trim().length > 0) {
    return preview.trim().slice(0, 60);
  }
  return new Date(createdAt).toISOString().slice(0, 10);
}

function isoOrEmpty(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

/**
 * Handle every spar.* message from a single companion device. The
 * caller (companion-ws) is responsible for narrowing the message
 * type union and providing the sender that writes back to THIS
 * specific socket.
 */
export async function handleSparMessage(
  ctx: HandleContext,
  msg: CompanionToSparMessage,
): Promise<void> {
  switch (msg.type) {
    case "spar.state.request":
      ctx.send({ type: "spar.state", state: ctx.state.state });
      return;
    case "spar.history.request": {
      handleHistoryRequest(ctx, msg);
      return;
    }
    case "spar.conversations.list": {
      handleConversationsList(ctx);
      return;
    }
    case "spar.workers.request": {
      handleWorkersRequest(ctx);
      return;
    }
    case "spar.workers.subscribe": {
      handleWorkersSubscribe(ctx);
      return;
    }
    case "spar.tasks.request": {
      handleTasksRequest(ctx, msg);
      return;
    }
    case "spar.tasks.subscribe": {
      handleTasksSubscribe(ctx, msg);
      return;
    }
    case "spar.text": {
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text) return;
      if (ctx.state.busy) return;
      ctx.state.busy = true;
      try {
        await runTextTurn(ctx, text, parseConversationId(msg.conversationId));
      } finally {
        ctx.state.busy = false;
      }
      return;
    }
    case "spar.audio.start":
      // Reset any half-buffered turn that never got a stop. Defensive:
      // a clean start cancels the previous tape rather than splicing.
      ctx.state.audioChunks = [];
      ctx.state.audioBytes = 0;
      ctx.state.audioStartedAt = Date.now();
      setState(ctx, "listening");
      return;
    case "spar.audio.chunk": {
      if (ctx.state.state !== "listening") return;
      if (typeof msg.data !== "string" || !msg.data) return;
      try {
        const buf = Buffer.from(msg.data, "base64");
        if (buf.length === 0) return;
        ctx.state.audioChunks.push(buf);
        ctx.state.audioBytes += buf.length;
      } catch {
        /* malformed base64; drop */
      }
      return;
    }
    case "spar.audio.stop":
      if (ctx.state.state !== "listening") return;
      if (ctx.state.busy) return;
      ctx.state.busy = true;
      try {
        await processAudioStop(ctx, parseConversationId(msg.conversationId));
      } finally {
        ctx.state.busy = false;
      }
      return;
    default:
      return;
  }
}

/** Drop any buffered audio + reset the relay state. Called on socket
 *  close so a half-buffered turn doesn't survive into the next
 *  reconnect of the same device. Also cancels any active workers /
 *  tasks subscriptions so the per-process registries don't leak
 *  callbacks targeting a dead socket. */
export function resetSparState(state: CompanionSparState): void {
  state.audioChunks = [];
  state.audioBytes = 0;
  state.audioStartedAt = null;
  state.busy = false;
  state.state = "idle";
  if (state.workersTimer) {
    clearInterval(state.workersTimer);
    state.workersTimer = null;
  }
  state.workersLastSent.clear();
  if (state.tasksUnsub) {
    try {
      state.tasksUnsub();
    } catch {
      /* ignore */
    }
    state.tasksUnsub = null;
  }
}

async function processAudioStop(
  ctx: HandleContext,
  preferredConversationId: number | null,
): Promise<void> {
  const pcm = Buffer.concat(ctx.state.audioChunks);
  ctx.state.audioChunks = [];
  ctx.state.audioBytes = 0;
  ctx.state.audioStartedAt = null;
  if (pcm.length === 0) {
    setState(ctx, "idle");
    return;
  }
  setState(ctx, "thinking");
  let text = "";
  try {
    const result = await transcribePcm(pcm, COMPANION_PCM_SAMPLE_RATE);
    text = result.text.trim();
  } catch (err) {
    console.warn(
      "[companion-spar] transcribe failed:",
      err instanceof Error ? err.message : String(err),
    );
    setState(ctx, "idle");
    return;
  }
  if (!text) {
    // Whisper got nothing usable. Send the empty transcript so the
    // companion knows we tried, and bounce back to idle.
    ctx.send({ type: "spar.transcript", text: "" });
    setState(ctx, "idle");
    return;
  }
  ctx.send({ type: "spar.transcript", text });
  await runTextTurn(ctx, text, preferredConversationId);
}

async function runTextTurn(
  ctx: HandleContext,
  text: string,
  preferredConversationId: number | null,
): Promise<void> {
  const userId = ctx.user.id;

  // Resolve the conversation. Order of preference:
  //   1. Caller-supplied id (for switching between threads).
  //   2. Latest conversation for this user.
  //   3. Fresh conversation if this is the user's first turn.
  // The id is validated against ownership via getSparConversation;
  // if the companion sent a stale or someone else's id we silently
  // fall back instead of erroring out, so the turn still lands.
  let conversationId: number | null = null;
  if (preferredConversationId != null) {
    const owned = getSparConversation(userId, preferredConversationId);
    if (owned) conversationId = owned.id;
  }
  if (conversationId == null) conversationId = latestConversationId(userId);
  if (conversationId == null) {
    conversationId = createSparConversation(userId, null).id;
  }

  // Persist + broadcast the user turn so the browser spar tab sees
  // it land in real time.
  const userRow = appendSparMessage({
    conversationId,
    userId,
    role: "user",
    content: text,
  });
  if (userRow) {
    try {
      broadcastSparMessage(userId, {
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
  }

  setState(ctx, "thinking");

  // Build the same baseline context the browser /api/spar route uses,
  // minus the MCP tool surface. The companion relay is a fast
  // conversational path; tool calls happen through the browser tab.
  const heartbeat = readHeartbeat(userId);
  const userProfile = readProfile(userId);
  let brainBlock = "";
  try {
    brainBlock = loadBrainContext().block;
  } catch {
    /* brain load failure is non-fatal; continue with empty block */
  }
  const recent = getRecentMessages(conversationId, RELAY_HISTORY_LIMIT);
  const history: SparMessage[] = recent.map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
  }));

  let reply = "";
  try {
    reply = await collectFromClaudeCli({
      systemPrompt: buildSparSystemPrompt(ctx.user.name),
      heartbeat,
      profile: "",
      userProfile,
      brain: brainBlock,
      history,
      model: SPAR_MODEL,
      maxTurns: 1,
    });
  } catch (err) {
    console.warn(
      "[companion-spar] LLM call failed:",
      err instanceof Error ? err.message : String(err),
    );
    setState(ctx, "idle");
    return;
  }
  reply = reply.trim();
  if (!reply) {
    setState(ctx, "idle");
    return;
  }

  const assistantRow = appendSparMessage({
    conversationId,
    userId,
    role: "assistant",
    content: reply,
  });
  if (assistantRow) {
    try {
      broadcastSparMessage(userId, {
        conversationId: assistantRow.conversationId,
        message: {
          id: assistantRow.id,
          role: assistantRow.role,
          content: assistantRow.content,
          toolCalls: assistantRow.toolCalls,
          createdAt: assistantRow.createdAt,
        },
      });
    } catch {
      /* broadcast failure is non-fatal */
    }
  }

  // Send the text response to the companion so its chat view fills
  // in even before TTS finishes streaming.
  ctx.send({ type: "spar.text.response", text: reply, final: true });

  setState(ctx, "speaking");
  try {
    await streamTtsToCompanion(ctx, reply);
  } catch (err) {
    console.warn(
      "[companion-spar] TTS streaming failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  ctx.send({ type: "spar.audio.response.end" });
  setState(ctx, "idle");
}

function handleHistoryRequest(
  ctx: HandleContext,
  msg: Extract<CompanionToSparMessage, { type: "spar.history.request" }>,
): void {
  const userId = ctx.user.id;
  let conversationId = parseConversationId(msg.conversationId);
  if (conversationId != null) {
    const owned = getSparConversation(userId, conversationId);
    if (!owned) conversationId = null;
  }
  if (conversationId == null) conversationId = latestConversationId(userId);
  if (conversationId == null) {
    // No conversations yet for this user. Send back an empty history
    // pinned to id "0" so the companion can render its empty state
    // without a second round-trip.
    ctx.send({
      type: "spar.history.response",
      conversationId: "0",
      messages: [],
    });
    return;
  }
  let limit = HISTORY_DEFAULT_LIMIT;
  if (typeof msg.limit === "number" && Number.isFinite(msg.limit)) {
    limit = Math.max(1, Math.min(HISTORY_MAX_LIMIT, Math.floor(msg.limit)));
  }
  // getRecentMessages already returns oldest-first (ASC after the
  // inner LIMIT slice), which matches the protocol's "oldest first"
  // contract; no need to re-sort here.
  const rows = getRecentMessages(conversationId, limit);
  const messages: CompanionHistoryMessage[] = rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      role: r.role === "assistant" ? "assistant" : "user",
      text: r.content,
      timestamp: isoOrEmpty(r.createdAt),
    }));
  ctx.send({
    type: "spar.history.response",
    conversationId: String(conversationId),
    messages,
  });
}

function handleConversationsList(ctx: HandleContext): void {
  const userId = ctx.user.id;
  // listConversations is already ORDER BY updated_at DESC; preserve
  // that order on the wire so the companion can render newest-first
  // without sorting again.
  const rows = listConversations(userId, CONVERSATIONS_LIST_LIMIT);
  const conversations: CompanionConversationSummary[] = rows.map((row) => ({
    id: String(row.id),
    title: deriveConversationTitle(row.title, row.preview ?? null, row.createdAt),
    lastMessage: row.preview ?? undefined,
    lastMessageAt: isoOrEmpty(row.updatedAt),
    messageCount: row.messageCount ?? 0,
  }));
  ctx.send({
    type: "spar.conversations.response",
    conversations,
  });
}

// ----- Workers --------------------------------------------------------

const WORKERS_POLL_MS = 5_000;

function buildWorkerSummaries(user: User): CompanionWorkerSummary[] {
  let projects: ReturnType<typeof visibleProjects>;
  try {
    projects = visibleProjects(user);
  } catch {
    return [];
  }
  // Cache the user's recent dispatches once per snapshot pass; the
  // ring is bounded to MAX_LOG_PER_USER (20) so this is cheap.
  let dispatches: ReturnType<typeof recentDispatches> = [];
  try {
    dispatches = recentDispatches(user.id);
  } catch {
    /* dispatch log read failures are non-fatal; workers still render */
  }
  const out: CompanionWorkerSummary[] = [];
  for (const project of projects) {
    let sessions: ReturnType<typeof listSessionsForProject> = [];
    try {
      sessions = listSessionsForProject(project.id);
    } catch {
      /* terminal-backend not ready, treat as no sessions */
    }
    let status: CompanionWorkerSummary["status"];
    let lastActivityMs: number | null = null;
    if (sessions.length === 0) {
      status = "idle";
    } else {
      // Aggregate across multiple sessions: any "working" beats
      // "done"; the panel renders one row per project, not per
      // session, so we collapse here.
      let anyWorking = false;
      let anyDone = false;
      for (const s of sessions) {
        const tail = s.scrollback.slice(-STATE_TAIL_BYTES);
        const detection = detectWorkerState(tail, s.sessionId, s.startedAt);
        if (
          detection.state === "thinking" ||
          detection.state === "permission_gate" ||
          detection.state === "awaiting_input"
        ) {
          anyWorking = true;
        } else {
          anyDone = true;
        }
        if (s.startedAt && (lastActivityMs == null || s.startedAt > lastActivityMs)) {
          lastActivityMs = s.startedAt;
        }
      }
      status = anyWorking ? "working" : anyDone ? "done" : "idle";
    }
    // The most recent dispatch for this project is a strong activity
    // proxy too; bump lastActivity if it's more recent than the
    // session start.
    let lastDispatchPrompt: string | undefined;
    for (const d of dispatches) {
      if (d.projectId !== project.id) continue;
      lastDispatchPrompt = d.prompt;
      const stamp = d.completedAt ?? d.confirmedAt;
      if (stamp && (lastActivityMs == null || stamp > lastActivityMs)) {
        lastActivityMs = stamp;
      }
      break;
    }
    out.push({
      projectId: project.id,
      name: project.name,
      status,
      lastActivity:
        lastActivityMs != null
          ? new Date(lastActivityMs).toISOString()
          : undefined,
      lastDispatch: lastDispatchPrompt,
    });
  }
  return out;
}

function workerSignature(w: CompanionWorkerSummary): string {
  // Stable serialisation for the dedupe map. Field order matters; keep
  // it identical between subscribe-time snapshot and poll-tick diff.
  return JSON.stringify([w.status, w.lastActivity ?? "", w.lastDispatch ?? ""]);
}

function handleWorkersRequest(ctx: HandleContext): void {
  const workers = buildWorkerSummaries(ctx.user);
  ctx.send({ type: "spar.workers.response", workers });
}

function handleWorkersSubscribe(ctx: HandleContext): void {
  // Initial snapshot immediately so the companion has data to render
  // before the first poll tick fires.
  const initial = buildWorkerSummaries(ctx.user);
  ctx.send({ type: "spar.workers.response", workers: initial });
  ctx.state.workersLastSent.clear();
  for (const w of initial) {
    ctx.state.workersLastSent.set(w.projectId, workerSignature(w));
  }
  // Replace any prior timer so re-subscribing is idempotent. The
  // resetSparState call on close clears whichever timer is current.
  if (ctx.state.workersTimer) clearInterval(ctx.state.workersTimer);
  ctx.state.workersTimer = setInterval(() => {
    let snap: CompanionWorkerSummary[] = [];
    try {
      snap = buildWorkerSummaries(ctx.user);
    } catch (err) {
      console.warn(
        "[companion-spar] worker poll failed:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    for (const w of snap) {
      const sig = workerSignature(w);
      if (ctx.state.workersLastSent.get(w.projectId) === sig) continue;
      ctx.state.workersLastSent.set(w.projectId, sig);
      try {
        ctx.send({ type: "spar.workers.update", worker: w });
      } catch {
        /* socket gone; close handler will sweep */
      }
    }
  }, WORKERS_POLL_MS);
}

// ----- Tasks (remarks) ------------------------------------------------

interface RemarkRowMin {
  id: number;
  user_id: number;
  project_id: string;
  body: string;
  created_at: number;
  resolved_at: number | null;
  tags: string | null;
}

const TASKS_DEFAULT_LIMIT = 50;
const TASKS_MAX_LIMIT = 200;

function parseTagsField(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function remarkRowToTaskSummary(r: RemarkRowMin): CompanionTaskSummary {
  const tags = parseTagsField(r.tags);
  return {
    id: String(r.id),
    text: r.body,
    tag: tags.length > 0 ? tags[0] : undefined,
    resolved: r.resolved_at != null,
    projectId: r.project_id || undefined,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function loadRemarkById(remarkId: number): RemarkRowMin | null {
  return (
    (getDb()
      .prepare(
        "SELECT id, user_id, project_id, body, created_at, resolved_at, tags FROM remarks WHERE id = ?",
      )
      .get(remarkId) as RemarkRowMin | undefined) ?? null
  );
}

function fetchTasks(
  user: User,
  opts: { resolved?: boolean; tag?: string; limit?: number },
): CompanionTaskSummary[] {
  const limit = Math.max(
    1,
    Math.min(TASKS_MAX_LIMIT, Math.floor(opts.limit ?? TASKS_DEFAULT_LIMIT)),
  );
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.resolved === true) where.push("resolved_at IS NOT NULL");
  if (opts.resolved === false) where.push("resolved_at IS NULL");
  // Over-fetch when filtering by tag because tags are stored as JSON
  // and SQLite's JSON1 isn't guaranteed across builds.
  const fetchLimit = opts.tag ? Math.max(limit * 4, 100) : limit;
  const sql = `
    SELECT id, user_id, project_id, body, created_at, resolved_at, tags
      FROM remarks
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC
     LIMIT ?
  `;
  const rows = getDb()
    .prepare(sql)
    .all(...params, fetchLimit) as RemarkRowMin[];
  const tagFilter = opts.tag ? opts.tag.trim().toLowerCase() : "";
  const visible = rows.filter((r) => canAccessProject(user, r.project_id));
  let summaries = visible.map(remarkRowToTaskSummary);
  if (tagFilter) {
    summaries = summaries.filter((s) => {
      const tags = parseTagsField(
        // remarkRowToTaskSummary already collapsed to a single tag,
        // but tagFilter should match ANY tag. Re-parse from the
        // matching row to scan the full list.
        rows.find((r) => String(r.id) === s.id)?.tags ?? null,
      );
      return tags.some((t) => t.toLowerCase() === tagFilter);
    });
  }
  return summaries.slice(0, limit);
}

function handleTasksRequest(
  ctx: HandleContext,
  msg: Extract<CompanionToSparMessage, { type: "spar.tasks.request" }>,
): void {
  const resolved =
    typeof msg.resolved === "boolean"
      ? msg.resolved
      : // Default per spec: unresolved only.
        false;
  const tag =
    typeof msg.tag === "string" && msg.tag.trim().length > 0
      ? msg.tag.trim()
      : undefined;
  const limit =
    typeof msg.limit === "number" && Number.isFinite(msg.limit)
      ? msg.limit
      : undefined;
  const tasks = fetchTasks(ctx.user, { resolved, tag, limit });
  ctx.send({ type: "spar.tasks.response", tasks });
}

function handleTasksSubscribe(
  ctx: HandleContext,
  msg: Extract<CompanionToSparMessage, { type: "spar.tasks.subscribe" }>,
): void {
  // Initial snapshot. Default filter (unresolved, no tag, default
  // limit) so the subscription mirrors what the request handler
  // returns when called with no args. The companion can always send
  // a tasks.request with custom filters for a one-off pull.
  const tasks = fetchTasks(ctx.user, { resolved: false });
  ctx.send({ type: "spar.tasks.response", tasks });

  // Replace any prior subscription so re-subscribing is idempotent.
  if (ctx.state.tasksUnsub) {
    try {
      ctx.state.tasksUnsub();
    } catch {
      /* ignore */
    }
  }
  ctx.state.tasksUnsub = registerTaskListener((projectId, remarkId, action) => {
    if (action === "deleted") {
      // The wire protocol doesn't differentiate deletes; the companion
      // will see the row vanish on the next tasks.request. Skipping
      // here keeps the update stream additive-only.
      return;
    }
    if (!canAccessProject(ctx.user, projectId)) return;
    const row = loadRemarkById(remarkId);
    if (!row) return;
    try {
      ctx.send({
        type: "spar.tasks.update",
        task: remarkRowToTaskSummary(row),
      });
    } catch {
      /* socket gone; close handler will sweep */
    }
  });
  // Touch msg so the no-unused-args lint stays quiet on a handler
  // that intentionally takes the message for future filter args.
  void msg;
}

// ----- Remark change subscribers --------------------------------------
//
// lib/ws.ts:broadcastRemark calls notifyRemarkChange after every
// remark mutation that goes through the spar tools. We keep a
// per-process listener registry here so each subscribed companion
// socket gets a per-action callback without needing to poll the
// remarks table itself.

type RemarkChangeListener = (
  projectId: string,
  remarkId: number,
  action: "added" | "deleted",
) => void;

const remarkListeners = new Set<RemarkChangeListener>();

export function registerTaskListener(listener: RemarkChangeListener): () => void {
  remarkListeners.add(listener);
  return () => {
    remarkListeners.delete(listener);
  };
}

export function notifyRemarkChange(
  projectId: string,
  remarkId: number,
  action: "added" | "deleted",
): void {
  for (const listener of remarkListeners) {
    try {
      listener(projectId, remarkId, action);
    } catch (err) {
      console.warn(
        "[companion-spar] remark listener threw:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function streamTtsToCompanion(
  ctx: HandleContext,
  text: string,
): Promise<void> {
  const port = getKokoroPort();
  const upstream = await fetch(`http://127.0.0.1:${port}/synth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    cache: "no-store",
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`kokoro returned ${upstream.status}`);
  }
  // Kokoro sends back the full WAV body. Read into chunks of
  // TTS_CHUNK_BYTES and base64 each one so the companion can start
  // decoding while later chunks are still on the wire.
  const reader = upstream.body.getReader();
  let leftover = Buffer.alloc(0);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    leftover = Buffer.concat([leftover, Buffer.from(value)]);
    while (leftover.length >= TTS_CHUNK_BYTES) {
      const slice = leftover.subarray(0, TTS_CHUNK_BYTES);
      leftover = leftover.subarray(TTS_CHUNK_BYTES);
      ctx.send({
        type: "spar.audio.response",
        data: slice.toString("base64"),
      });
    }
  }
  if (leftover.length > 0) {
    ctx.send({
      type: "spar.audio.response",
      data: leftover.toString("base64"),
    });
  }
}
