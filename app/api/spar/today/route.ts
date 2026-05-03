// Aggregator endpoint for the Spar home dashboard ("Today at a glance"
// strip). Bundles three signals into a single round-trip so the new
// SparTodayPanel can paint without firing three independent fetches:
//
//   - terminals: which workers are busy / idle right now (top 6 +
//     summary counts) — same shape the existing worker-status route
//     uses, just trimmed for the dashboard's compact card.
//   - openLoops: the "Open loops" section from the caller's heartbeat
//     file, parsed via the same `parseHeartbeat` helper the
//     /heartbeat page uses, so the at-a-glance view never disagrees
//     with the full one.
//   - remarks: the most recent unresolved remarks across every
//     project the caller can see, including the project name so the
//     UI can group/label without a second lookup.
//
// All three are read-only views over data the dashboard already owns,
// so this is a pure aggregator — no new state, no writes. Polled at
// ~5s by the SparTodayPanel.

import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { listSessionsForProject } from "@/lib/terminal-backend";
import { detectWorkerState } from "@/lib/terminal-state";
import { readHeartbeat } from "@/lib/heartbeat";
import { getDb } from "@/lib/db";

// Mirrors components/HeartbeatView.tsx parseHeartbeat. Kept inline so a
// server route doesn't have to import a "use client" component just for
// a 30-line markdown reducer.
function parseHeartbeatBody(body: string): { title: string; items: string[] }[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const sections: { title: string; items: string[] }[] = [];
  let current: { title: string; items: string[] } | null = null;
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      if (current) sections.push(current);
      current = { title: headerMatch[1].trim(), items: [] };
      continue;
    }
    if (!current) current = { title: "Notes", items: [] };
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) current.items.push(bullet[1].trim());
    else if (line.trim().length > 0) current.items.push(line.trim());
  }
  if (current) sections.push(current);
  return sections;
}

export const dynamic = "force-dynamic";

interface TerminalSummary {
  id: string;
  projectId: string;
  name: string;
  state:
    | "thinking"
    | "permission_gate"
    | "at_prompt"
    | "awaiting_input"
    | "unknown"
    | "idle";
  hint: string;
  running: boolean;
  startedAt: number | null;
}

interface RemarkSummary {
  id: number;
  projectId: string;
  projectName: string;
  userId: number;
  userName: string;
  category: "frontend" | "backend" | "other";
  body: string;
  createdAt: number;
  path: string | null;
  line: number | null;
}

const MAX_TERMINALS = 6;
const MAX_REMARKS = 8;

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const user = auth.user;

  const projects = visibleProjects(user);
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  // ── Terminals ────────────────────────────────────────────────────
  // Walk every visible project's live sessions and reduce to a flat
  // list. We don't need the full payload the worker-status route
  // returns — just enough to render the summary cards (project name,
  // detected state, short hint).
  const terminals: TerminalSummary[] = [];
  let totalRunning = 0;
  let totalBusy = 0;
  for (const p of projects) {
    let sessions: ReturnType<typeof listSessionsForProject>;
    try {
      sessions = listSessionsForProject(p.id);
    } catch {
      sessions = [];
    }
    if (sessions.length === 0) continue;
    for (const s of sessions) {
      totalRunning += 1;
      // Same state heuristic as the mission-control panel so the
      // at-a-glance card never disagrees with the sidebar.
      const { state, hint, lastLine } = detectWorkerState(
        s.scrollback,
        p.id,
        s.startedAt,
      );
      const isBusy =
        state === "thinking" ||
        state === "permission_gate" ||
        state === "awaiting_input";
      if (isBusy) totalBusy += 1;
      if (terminals.length < MAX_TERMINALS) {
        terminals.push({
          id: `${p.id}:${s.sessionId}`,
          projectId: p.id,
          name: p.name,
          state,
          hint: hint || lastLine || "",
          running: true,
          startedAt: s.startedAt ?? null,
        });
      }
    }
  }
  // Busy first, then idle/unknown. Stable within each bucket so the UI
  // doesn't shuffle on each poll.
  const stateRank = (t: TerminalSummary): number => {
    if (t.state === "permission_gate") return 0;
    if (t.state === "awaiting_input") return 1;
    if (t.state === "thinking") return 2;
    if (t.state === "at_prompt") return 3;
    return 4;
  };
  terminals.sort((a, b) => stateRank(a) - stateRank(b));

  // ── Open loops (heartbeat) ───────────────────────────────────────
  const heartbeatBody = readHeartbeat(user.id);
  const sections = parseHeartbeatBody(heartbeatBody);
  const loopsSection = sections.find((s) =>
    /^open\s*loops?$/i.test(s.title.trim()),
  );
  const openLoops = (loopsSection?.items ?? []).slice(0, 8);

  // ── Unresolved remarks across visible projects ───────────────────
  const allowedProjectIds = projects.map((p) => p.id);
  let remarks: RemarkSummary[] = [];
  if (allowedProjectIds.length > 0) {
    const placeholders = allowedProjectIds.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT r.id, r.user_id, r.project_id, r.path, r.line, r.category, r.body, r.created_at, u.name AS user_name
           FROM remarks r JOIN users u ON u.id = r.user_id
          WHERE r.resolved_at IS NULL
            AND r.project_id IN (${placeholders})
          ORDER BY r.created_at DESC
          LIMIT ?`,
      )
      .all(...allowedProjectIds, MAX_REMARKS) as Array<{
      id: number;
      user_id: number;
      project_id: string;
      path: string | null;
      line: number | null;
      category: "frontend" | "backend" | "other";
      body: string;
      created_at: number;
      user_name: string;
    }>;
    remarks = rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: projectNameById.get(r.project_id) ?? r.project_id,
      userId: r.user_id,
      userName: r.user_name,
      category: r.category,
      body: r.body,
      createdAt: r.created_at,
      path: r.path,
      line: r.line,
    }));
  }

  return NextResponse.json({
    terminals: {
      items: terminals,
      runningCount: totalRunning,
      busyCount: totalBusy,
      totalProjects: projects.length,
    },
    openLoops,
    remarks,
  });
}
