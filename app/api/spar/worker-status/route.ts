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
    // Trim very long lines so the panel layout stays sane.
    return line.length > 140 ? line.slice(0, 137) + "…" : line;
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
    const lastLine = pickSummaryLine(cleaned);
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
