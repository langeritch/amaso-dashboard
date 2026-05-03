// Heartbeat endpoint hit by every logged-in tab every ~30 s. Upserts
// the presence row for (user, client_id) and — when the page changes
// — appends a page_visit activity event. The super-user activity
// panel reads from the same tables this writes to.
//
// Auth is `apiRequireUser`: any logged-in account heartbeats; only
// super-user can READ via the admin endpoint.

import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { recordActivity, upsertPresence } from "@/lib/presence";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  let body: { clientId?: unknown; path?: unknown };
  try {
    body = (await req.json()) as { clientId?: unknown; path?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const clientId =
    typeof body.clientId === "string" && body.clientId.trim()
      ? body.clientId.trim().slice(0, 64)
      : "";
  if (!clientId) {
    return NextResponse.json({ error: "missing_client_id" }, { status: 400 });
  }
  const path =
    typeof body.path === "string" ? body.path.trim().slice(0, 512) : null;
  const userAgent =
    req.headers.get("user-agent")?.slice(0, 256) ?? null;

  const { presence, pathChanged } = upsertPresence({
    userId: auth.user.id,
    clientId,
    path,
    userAgent,
  });

  // Page-visit log fires only when the path actually changes — a
  // 30-s heartbeat on the same page doesn't bloat the activity log.
  if (pathChanged && path) {
    recordActivity({
      userId: auth.user.id,
      presenceId: presence.id,
      kind: "page_visit",
      label: path,
    });
  }

  return NextResponse.json({ ok: true, presenceId: presence.id });
}
