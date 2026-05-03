// Two surfaces on one route:
//   POST  — any logged-in user records a feature-usage event
//           (call started, dispatch fired, deploy run, etc). Detail
//           field is a freeform JSON object kept small.
//   GET   — super-user reads the live panel feed: online users with
//           per-tab session info + recent activity log.

import { NextResponse } from "next/server";
import { apiRequireSuperUser, apiRequireUser } from "@/lib/guard";
import {
  listOnlineUsers,
  listRecentActivity,
  recordActivity,
} from "@/lib/presence";

export const dynamic = "force-dynamic";

const MAX_LABEL_LEN = 200;
const MAX_DETAIL_BYTES = 4_096;

export async function POST(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  let body: {
    label?: unknown;
    detail?: unknown;
    presenceId?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const label =
    typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    return NextResponse.json({ error: "missing_label" }, { status: 400 });
  }
  if (label.length > MAX_LABEL_LEN) {
    return NextResponse.json({ error: "label_too_long" }, { status: 400 });
  }

  const detail =
    body.detail && typeof body.detail === "object" ? body.detail : undefined;
  if (detail) {
    const serialized = JSON.stringify(detail);
    if (serialized.length > MAX_DETAIL_BYTES) {
      return NextResponse.json({ error: "detail_too_large" }, { status: 400 });
    }
  }

  const presenceId =
    typeof body.presenceId === "number" && Number.isInteger(body.presenceId)
      ? body.presenceId
      : null;

  recordActivity({
    userId: auth.user.id,
    presenceId,
    kind: "action",
    label,
    detail,
  });
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const auth = await apiRequireSuperUser();
  if (!auth.ok) return auth.res;
  const online = listOnlineUsers();
  const recent = listRecentActivity(200);
  return NextResponse.json({ online, recent, now: Date.now() });
}
