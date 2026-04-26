import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getSession } from "@/lib/recording";
import { snapshotTab } from "@/lib/browser-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/recording/sessions/[id]/tabs/[tabId]/snapshot
 *
 * Heavy, on-demand snapshot of a single tab — Playwright accessibility
 * tree + visible body text. Only call when the lightweight `state`
 * endpoint isn't enough; AX-tree extraction walks the whole DOM and
 * innerText forces layout, so polling this in a loop will tank the
 * user's interactive performance.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; tabId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id: sessionId, tabId: tabIdRaw } = await ctx.params;

  const session = getSession(sessionId, auth.user.id);
  if (!session) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const tabId = Number(tabIdRaw);
  if (!Number.isFinite(tabId)) {
    return NextResponse.json({ error: "bad_tab_id" }, { status: 400 });
  }

  const snap = await snapshotTab(auth.user.id, tabId);
  if (!snap) {
    return NextResponse.json(
      { error: "tab_or_browser_unavailable" },
      { status: 404 },
    );
  }

  return NextResponse.json(snap);
}
