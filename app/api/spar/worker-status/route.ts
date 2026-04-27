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
import { apiRequireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { getSession } from "@/lib/terminal";
import {
  ANSI_REGEX,
  TUI_CHROME_REGEX,
  cleanScrollback,
  detectTerminalState,
} from "@/lib/spar-tools-context";

export const dynamic = "force-dynamic";

// Tail size for state detection. Smaller than the MCP tool's default
// because we run this for every visible project on every poll —
// 16 KB × N projects × every-3s would burn CPU on the regex sweeps.
// 8 KB is plenty for the last-line + state heuristic.
const TAIL_BYTES = 8_192;

// How many trailing lines of cleaned scrollback to scan for the
// "summary" line. We pick the last non-empty line that isn't pure
// chrome — the heuristic filters in cleanScrollback already drop the
// status spinners, so this just walks backward until something
// useful surfaces.
const SUMMARY_SCAN_LINES = 8;

// How far up the partially-cleaned tail to look for a live activity
// line when state === "thinking". Status lines always sit at the
// bottom of the TUI; 40 is plenty.
const ACTIVITY_SCAN_LINES = 40;

// "Active status" line shape: a verb in "-ing" form anywhere on the
// line plus a parenthesised timer. Examples:
//   "✢ Elucidating… (28s · ↓ 1.0k tokens · still thinking)"
//   "* Cogitating (4s · esc to interrupt)"
//   "✻ Cogitating… (1m 11s · ↓ 2.4k tokens · still thinking)"
// The optional "Nm " prefix matches Claude Code's switch from "(Ns"
// to "(Nm Ms" once the timer crosses 60 seconds — without it the
// status line stops being recognised at the one-minute mark.
const ACTIVITY_LINE_REGEX =
  /\b[A-Za-z]+ing\b[^\n]{0,80}\(\s*(?:\d+\s*m\s*)?\d+\s*s\b/i;

interface WorkerStatus {
  id: string;
  name: string;
  visibility: "team" | "client" | "public";
  running: boolean;
  startedAt: number | null;
  state: "thinking" | "permission_gate" | "at_prompt" | "unknown" | "idle";
  hint: string;
  /** One-line summary pulled from the terminal tail. Empty when the
   *  PTY isn't running or no usable line was found. */
  lastLine: string;
}

function pickSummaryLine(clean: string): string {
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // Walk backward but cap at SUMMARY_SCAN_LINES so a very long clean
  // tail doesn't waste cycles. A bare `>` prompt isn't useful — skip
  // it and keep looking.
  const tail = lines.slice(-SUMMARY_SCAN_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line) continue;
    if (/^[>│▌$›]\s*$/.test(line)) continue;
    if (/^>/.test(line)) continue;
    // Trim very long lines so the panel layout stays sane.
    return line.length > 140 ? line.slice(0, 137) + "…" : line;
  }
  return "";
}

// Pulls the live "Elucidating… (28s · …)" status row out of the partially
// cleaned tail. Operates on `forState` (ANSI + TUI-chrome stripped, but
// carriage-return overwrites and noise lines preserved) so the row Claude
// Code rewrites in place is still visible. cleanScrollback drops these
// rows on purpose — for the MCP scrollback tool you don't want spinners
// — but the workers panel's whole job is to surface them.
function pickActivityLine(forState: string): string {
  const lines = forState.split(/\n/);
  const start = Math.max(0, lines.length - ACTIVITY_SCAN_LINES);
  for (let i = lines.length - 1; i >= start; i--) {
    // Each logical line may contain \r-overwritten variants where the
    // TUI rewrote the same row repeatedly. Only the segment after the
    // final \r is what the user actually sees on screen — so walk
    // those right-to-left and pick the first non-empty match.
    const segs = lines[i].split("\r");
    for (let j = segs.length - 1; j >= 0; j--) {
      const seg = segs[j].trim();
      if (!seg) continue;
      if (ACTIVITY_LINE_REGEX.test(seg)) {
        return seg.length > 140 ? seg.slice(0, 137) + "…" : seg;
      }
    }
  }
  return "";
}

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  const projects = visibleProjects(auth.user);
  const workers: WorkerStatus[] = projects.map((p) => {
    const session = getSession(p.id);
    if (!session) {
      return {
        id: p.id,
        name: p.name,
        visibility: p.visibility,
        running: false,
        startedAt: null,
        state: "idle",
        hint: "No terminal running.",
        lastLine: "",
      };
    }
    const sb = session.scrollback;
    const rawTail = sb.slice(Math.max(0, sb.length - TAIL_BYTES));
    // State detection runs on the raw-tail minus ANSI/box-drawing
    // (matches the MCP tool's path). Summary line uses the fully
    // cleaned tail so the user sees a readable sentence, not a
    // spinner row.
    const forState = rawTail
      .replace(ANSI_REGEX, "")
      .replace(TUI_CHROME_REGEX, "");
    const { state, hint } = detectTerminalState(forState);
    const cleaned = cleanScrollback(rawTail);
    // Always try the live activity row first, regardless of state.
    // Claude Code's TUI renders a `❯` prompt character below the
    // status line even while it's still thinking, which makes
    // `detectTerminalState` return "at_prompt" — so gating the
    // activity-line lookup on state === "thinking" hides the row in
    // exactly the case we want it most. The activity regex requires
    // both an "-ing" verb and a parenthesised timer, so a stale row
    // from a finished turn won't false-positive here.
    let lastLine = pickActivityLine(forState);
    if (!lastLine) lastLine = pickSummaryLine(cleaned);
    return {
      id: p.id,
      name: p.name,
      visibility: p.visibility,
      running: true,
      startedAt: session.startedAt,
      state: state as WorkerStatus["state"],
      hint,
      lastLine,
    };
  });

  return NextResponse.json({ workers });
}
