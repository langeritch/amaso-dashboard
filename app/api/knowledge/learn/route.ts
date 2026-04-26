import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  detectCorrectionLike,
  extractGraphFromTurn,
} from "@/lib/knowledge-graph-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fire-and-forget extraction endpoint. The Spar client calls this
 * after each assistant reply finishes streaming; we return 202
 * immediately and run the (slow) Claude CLI extraction in the
 * background.
 *
 * Best-effort: if the Node process dies mid-extraction, the next
 * turn produces facts — we lose one turn of memory updates, not
 * correctness. Callers that need confirmation should poll
 * GET /api/knowledge afterwards.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  let body: {
    userText?: unknown;
    assistantText?: unknown;
    isCorrection?: unknown;
  } | null = null;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const userText = typeof body?.userText === "string" ? body.userText : "";
  const assistantText =
    typeof body?.assistantText === "string" ? body.assistantText : "";
  // Trust the client flag if given; otherwise sniff the user text
  // server-side so we still catch corrections even when the client
  // doesn't pass the flag.
  const isCorrection =
    body?.isCorrection === true ||
    (body?.isCorrection === undefined && detectCorrectionLike(userText));

  void extractGraphFromTurn(user.id, userText, assistantText, {
    isCorrection,
  }).catch((err) => {
    console.warn(
      "[knowledge/learn] extract threw past its own handler:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return new Response(null, { status: 202 });
}
