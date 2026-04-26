import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { canUseChannel, insertMessage } from "@/lib/chat";
import { canAccessProject } from "@/lib/access";
import { broadcastChatMessage } from "@/lib/ws";
import { getProject } from "@/lib/config";
import { startRun, type ClaudeRun } from "@/lib/claude";

export const dynamic = "force-dynamic";

/**
 * POST /api/chat/channels/[id]/ai
 * Body: { projectId: string, prompt: string }
 *
 * Runs the Claude CLI non-interactively in the project's working dir and,
 * when the run finishes, posts the output back into this chat channel as
 * an ai_session message. The HTTP response returns immediately — output
 * arrives via the chat WebSocket broadcast.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  const channelId = Number(id);
  if (!Number.isFinite(channelId)) {
    return NextResponse.json({ error: "bad_channel" }, { status: 400 });
  }
  const channel = canUseChannel(auth.user, channelId);
  if (!channel) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { projectId?: string; prompt?: string }
    | null;
  if (!body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const projectId = String(body.projectId ?? "").trim();
  const prompt = String(body.prompt ?? "").trim();
  if (!projectId || !prompt) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!canAccessProject(auth.user, projectId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const project = getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  }

  let run: ClaudeRun;
  try {
    run = startRun(projectId, project.path, prompt, []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "start_failed";
    // Surface "already running" etc. back into the chat so the admin sees it.
    const notice = insertMessage(
      channelId,
      auth.user.id,
      `⚠ Could not start AI run: ${msg}`,
      "ai_session",
      { projectId, error: msg },
    );
    broadcastChatMessage(channelId, notice);
    return NextResponse.json({ error: msg }, { status: 409 });
  }

  run.emitter.on("end", () => {
    const out: string[] = [];
    const errs: string[] = [];
    for (const entry of run.log) {
      if (entry.kind === "out") out.push(entry.line);
      else if (entry.kind === "err") errs.push(entry.line);
    }
    const outputText = out.join("\n").trim();
    const errorText = errs.join("\n").trim();
    let finalBody: string;
    if (run.state === "completed") {
      finalBody = outputText || "(no output)";
    } else if (run.state === "cancelled") {
      finalBody = "(AI run cancelled)";
    } else {
      finalBody =
        `⚠ AI run failed${run.exitCode != null ? ` (exit ${run.exitCode})` : ""}` +
        (errorText ? `\n\n${errorText}` : "") +
        (outputText ? `\n\n${outputText}` : "");
    }
    try {
      const msg = insertMessage(
        channelId,
        auth.user.id,
        finalBody,
        "ai_session",
        { projectId, runId: run.id },
      );
      broadcastChatMessage(channelId, msg);
    } catch {
      /* best effort — DB may have closed on shutdown */
    }
  });

  return NextResponse.json({ runId: run.id }, { status: 202 });
}
