// Live "mission control" feed for the sparring page. For each project the
// caller can see, surfaces whether its PTY is running and — when it is —
// what state Claude Code appears to be in (`thinking`, `permission_gate`,
// `at_prompt`, `unknown`) plus a short, cleaned tail line so the UI can
// say at a glance "TF Pricing is asking permission to run a bash cmd".
//
// Reuses the same scrollback hygiene + state heuristic that the spar MCP
// `read_terminal_scrollback` tool uses (exported from spar-tools-context),
// so what the user sees here matches what Spar sees when it inspects a
// worker — same noise filter, same wording for state.

import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { listSessionsForProject } from "@/lib/terminal-backend";
import { cleanScrollback } from "@/lib/spar-tools-context";
import { recentDispatches } from "@/lib/spar-dispatch";
import {
  ACTIVITY_LINE_REGEX,
  detectWorkerState,
} from "@/lib/terminal-state";

export const dynamic = "force-dynamic";

interface WorkerStatus {
  /** Ground-truth activity flag: true if the session's terminal
   *  output changed at any point in the last ACTIVITY_WINDOW_MS.
   *  Replaces the brittle "is the last line a thinking spinner?"
   *  regex — if any bytes are flowing (timer ticking, spinner
   *  redrawing, characters streaming) it's working; otherwise it's
   *  done. Computed in the route itself by diffing the scrollback
   *  tail across calls. */
  outputChanging: boolean;
  /** Stable React key. `<projectId>:<sessionId>` so multiple sessions
   *  for the same project don't collide. For single-session projects
   *  this collapses to `<projectId>:<projectId>` — different from the
   *  pre-Stage-2 `id = projectId` shape, but UI consumers only treat
   *  it as an opaque key. `projectId` is broken out separately for
   *  any caller that needs it. */
  id: string;
  /** The owning project id (still useful for navigation / grouping). */
  projectId: string;
  /** Specific terminal session this row reflects. Equals projectId for
   *  the legacy single-session case, otherwise a `<projectId>__s…` id
   *  allocated by the spawn endpoint or the dispatch resolver. */
  sessionId: string;
  /** 1-based ordinal among this project's currently-live sessions,
   *  oldest-first. UI uses this to render "#1", "#2", … labels when
   *  the project has more than one session. Always >= 1 for running
   *  rows; 0 for the synthetic "no terminal" placeholder. */
  sessionOrdinal: number;
  /** Total live sessions for this project right now. Lets the UI
   *  decide whether to show the "#N" suffix (only when > 1). */
  projectSessionCount: number;
  name: string;
  visibility: "team" | "client" | "public";
  /** Optional category label from the project config. The workers
   *  panel groups rows under this label so related projects render
   *  together. Undefined for ungrouped entries. */
  group?: string;
  running: boolean;
  startedAt: number | null;
  state:
    | "thinking"
    | "permission_gate"
    | "at_prompt"
    | "awaiting_input"
    | "unknown"
    | "idle";
  hint: string;
  /** One-line summary pulled from the terminal tail. Empty when the
   *  PTY isn't running or no usable line was found. */
  lastLine: string;
  /** Most recent prompt the user submitted into this terminal,
   *  truncated. Sourced from cleaned scrollback by scanning for "> ..."
   *  lines, so it covers both spar dispatches and manually-typed
   *  prompts. Empty when the buffer has no prompt history. */
  lastPrompt: string;
  /** Slightly richer summary line for the hover card — same picker as
   *  `lastLine` but without the spinner-skip preference, so the popover
   *  can show what Claude actually said last instead of what it's
   *  currently thinking about. */
  lastOutputSummary: string;
  /** Count of distinct submitted prompts in the visible scrollback
   *  window. Approximate: the ring buffer caps how far back we can see,
   *  so very-long sessions undercount. Sufficient for "how many things
   *  has this worker chewed through this session" at a glance. */
  promptCount: number;
}

// Tail used only for the output-summary picker. State detection has
// its own tail size in lib/terminal-state.ts; the picker wants a touch
// more context so it can walk past recent spinner rows to find an
// actual sentence.
const SUMMARY_TAIL_BYTES = 32_000;

// Ground-truth activity detection: keep a snapshot of the last ~4 KB of
// every live session's scrollback and the wall-clock timestamp it last
// changed. On each poll we re-snapshot and compare; any byte difference
// stamps `lastChangedAt = now`. A session counts as actively working as
// long as its last change is within ACTIVITY_WINDOW_MS of now — covers
// timer ticks, spinner redraws, streamed text, anything that emits
// bytes. When the terminal sits at a static prompt the bytes stop
// flowing and the row flips to idle 5 s later. Replaces the regex-
// based "is the last line a thinking spinner?" check, which produced
// false-positives when Claude Code briefly painted a completion line
// that still carried an old "(8s)" suffix.
const ACTIVITY_WINDOW_MS = 5_000;
const ACTIVITY_TAIL_BYTES = 4_000;
interface ActivitySnapshot {
  tail: string;
  lastChangedAt: number;
}
declare global {
  // eslint-disable-next-line no-var
  var __amasoWorkerActivity: Map<string, ActivitySnapshot> | undefined;
}
function activityMap(): Map<string, ActivitySnapshot> {
  if (!globalThis.__amasoWorkerActivity) {
    globalThis.__amasoWorkerActivity = new Map();
  }
  return globalThis.__amasoWorkerActivity;
}
// Bare prompt-marker / input-box residue from Claude Code's TUI.
// After cleanScrollback strips box-drawing chars, the multi-line
// input box collapses down to a lone `❯` (or `>`/`$`/`›`) — never the
// user's typed text on the same line. So scrollback parsing can't
// recover the prompt content. Dispatch-log sourcing is reliable.
const PROMPT_MARKER_RX = /^[>│▌$›❯]\s*$/;

// Same backward-walk picker as pickSummaryLine but with a longer cap
// so the popover can carry a fuller sentence. Still skips prompts and
// in-flight activity rows — the popover is for "what Claude SAID",
// not "what it's doing now" (the badge already conveys state).
function pickOutputSummary(clean: string, lookback = 16): string {
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-lookback);
  const cap = (s: string) => (s.length > 220 ? s.slice(0, 217) + "…" : s);
  const COMPLETION_RX = /\w+(?:ed|t)\s+for\s+(?:\d+\s*m\s+)?\d+\s*s/i;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line) continue;
    if (PROMPT_MARKER_RX.test(line)) continue;
    if (COMPLETION_RX.test(line)) continue;
    if (ACTIVITY_LINE_REGEX.test(line)) continue;
    return cap(line);
  }
  return "";
}

function truncatePrompt(s: string, max = 80): string {
  const single = s.replace(/\s+/g, " ").trim();
  return single.length > max ? single.slice(0, max - 1).trimEnd() + "…" : single;
}

export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const projects = visibleProjects(auth.user);
  // Per-project dispatch summary built once and reused. recentDispatches
  // returns this user's last MAX_LOG_PER_USER (~20) dispatches across
  // all projects newest-first; we group by projectId. The promptCount
  // is bounded by that ring, so very-busy users can undercount — fine
  // for a "current session" hover card.
  const myDispatches = recentDispatches(auth.user.id, 20);
  const dispatchByProject = new Map<
    string,
    { count: number; latestPrompt: string }
  >();
  for (const d of myDispatches) {
    const cur = dispatchByProject.get(d.projectId) ?? {
      count: 0,
      latestPrompt: "",
    };
    cur.count += 1;
    if (!cur.latestPrompt) cur.latestPrompt = d.prompt;
    dispatchByProject.set(d.projectId, cur);
  }

  // One row per live session. Projects with no live session emit a
  // single placeholder row (running=false) so the panel can still
  // surface a "+ start" affordance and the historical lastPrompt.
  // Sessions are sorted oldest-first so the ordinal labels (#1, #2)
  // stay stable across polls — index 0 → "#1".
  const workers: WorkerStatus[] = [];
  const activity = activityMap();
  const liveSessionIds = new Set<string>();
  const now = Date.now();
  for (const p of projects) {
    const sessions = [...listSessionsForProject(p.id)].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    const dispatchInfo = dispatchByProject.get(p.id);
    if (sessions.length === 0) {
      workers.push({
        id: `${p.id}:${p.id}`,
        projectId: p.id,
        sessionId: p.id,
        sessionOrdinal: 0,
        projectSessionCount: 0,
        name: p.name,
        visibility: p.visibility,
        group: p.group,
        running: false,
        startedAt: null,
        state: "idle",
        hint: "No terminal running.",
        lastLine: "",
        outputChanging: false,
        // Even with no live PTY we still surface the latest prompt the
        // user/spar dispatched here — it's the easiest way to remember
        // "what was this worker doing before it exited" at a glance.
        lastPrompt: dispatchInfo
          ? truncatePrompt(dispatchInfo.latestPrompt)
          : "",
        lastOutputSummary: "",
        promptCount: dispatchInfo?.count ?? 0,
      });
      continue;
    }
    // Recent-dispatch info is per-project (the log doesn't currently
    // carry sessionId on every row), so every session for a project
    // sees the same lastPrompt / promptCount fallback. Acceptable —
    // the WorkerRow already disambiguates by session label and
    // scrollback tail.
    sessions.forEach((session, idx) => {
      const sb = session.scrollback;
      // detectWorkerState shares its tail/regex set with
      // terminal-idle.ts, so the row's badge always matches what
      // would actually fire an auto-report.
      const { state: finalState, hint: finalHint, lastLine } =
        detectWorkerState(sb, p.id, session.startedAt);
      const summaryTail = sb.slice(
        Math.max(0, sb.length - SUMMARY_TAIL_BYTES),
      );
      const cleanedSummary = cleanScrollback(summaryTail);
      const outputSummary = pickOutputSummary(cleanedSummary) || lastLine;

      // Diff this session's tail against the previous snapshot. Any
      // change (one byte is enough) re-stamps lastChangedAt; the row is
      // "active" while now - lastChangedAt < ACTIVITY_WINDOW_MS.
      liveSessionIds.add(session.sessionId);
      const tail = sb.slice(Math.max(0, sb.length - ACTIVITY_TAIL_BYTES));
      const prev = activity.get(session.sessionId);
      let lastChangedAt: number;
      if (!prev) {
        // First observation — assume working. The next poll establishes
        // the baseline, and if nothing actually moved we'll flip to
        // idle within ACTIVITY_WINDOW_MS.
        lastChangedAt = now;
        activity.set(session.sessionId, { tail, lastChangedAt });
      } else if (prev.tail !== tail) {
        lastChangedAt = now;
        prev.tail = tail;
        prev.lastChangedAt = now;
      } else {
        lastChangedAt = prev.lastChangedAt;
      }
      const outputChanging = now - lastChangedAt < ACTIVITY_WINDOW_MS;

      workers.push({
        id: `${p.id}:${session.sessionId}`,
        projectId: p.id,
        sessionId: session.sessionId,
        sessionOrdinal: idx + 1,
        projectSessionCount: sessions.length,
        name: p.name,
        visibility: p.visibility,
        group: p.group,
        running: true,
        startedAt: session.startedAt,
        state: finalState,
        hint: finalHint,
        lastLine,
        outputChanging,
        lastPrompt: dispatchInfo
          ? truncatePrompt(dispatchInfo.latestPrompt)
          : "",
        lastOutputSummary: outputSummary,
        promptCount: dispatchInfo?.count ?? 0,
      });
    });
  }
  // GC: drop activity snapshots for sessions that no longer appear in
  // any project's live list, otherwise the map grows without bound as
  // sessions come and go across long-running dashboard processes.
  for (const id of activity.keys()) {
    if (!liveSessionIds.has(id)) activity.delete(id);
  }

  return NextResponse.json({ workers });
}
