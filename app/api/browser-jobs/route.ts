// Browser Jobs HTTP surface. The workers panel polls GET every 10s
// to keep its Browser Jobs section live. POST is the same registration
// path the spar MCP tool uses (the tool calls into the local handler
// directly via TOOL_HANDLERS, not over HTTP, but exposing POST keeps
// the surface symmetric and lets a curl smoke-test the registry).
//
// Auth: apiRequireNonClient. Browser jobs are an internal-tool concept
// the client portal has no business reading or writing.

import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import {
  getActiveJobs,
  registerJob,
  type BrowserJob,
} from "@/lib/browser-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jobToWire(job: BrowserJob) {
  return {
    id: job.id,
    name: job.name,
    goal: job.goal,
    status: job.status,
    progress: job.progress,
    startedAt: job.startedAt,
    lastCheckedAt: job.lastCheckedAt,
    completedAt: job.completedAt,
    checkIntervalMs: job.checkIntervalMs,
  };
}

export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  return NextResponse.json({
    jobs: getActiveJobs(auth.user.id).map(jobToWire),
  });
}

export async function POST(req: Request) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    goal?: unknown;
    checkIntervalMs?: unknown;
  } | null;
  if (!body || typeof body.name !== "string" || typeof body.goal !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const name = body.name.trim();
  const goal = body.goal.trim();
  if (!name || !goal) {
    return NextResponse.json(
      { error: "name_and_goal_required" },
      { status: 400 },
    );
  }
  const checkIntervalMs =
    typeof body.checkIntervalMs === "number" ? body.checkIntervalMs : undefined;
  const job = registerJob({
    userId: auth.user.id,
    name,
    goal,
    checkIntervalMs,
  });
  return NextResponse.json({ job: jobToWire(job) });
}
