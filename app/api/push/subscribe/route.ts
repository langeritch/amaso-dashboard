import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import {
  deleteSubscription,
  pushEnabled,
  saveSubscription,
  type BrowserSubscription,
} from "@/lib/push";

export const dynamic = "force-dynamic";

/** Save (or refresh) a browser push subscription for the current user. */
export async function POST(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  if (!pushEnabled()) {
    return NextResponse.json({ error: "push_not_configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as {
    subscription?: BrowserSubscription;
  } | null;
  const sub = body?.subscription;
  if (
    !sub ||
    typeof sub.endpoint !== "string" ||
    typeof sub.keys?.p256dh !== "string" ||
    typeof sub.keys?.auth !== "string"
  ) {
    return NextResponse.json({ error: "bad_subscription" }, { status: 400 });
  }

  saveSubscription(
    auth.user.id,
    sub,
    req.headers.get("user-agent"),
  );
  return NextResponse.json({ ok: true });
}

/** Unsubscribe this browser's endpoint (fires on toggle-off or sign-out). */
export async function DELETE(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as {
    endpoint?: string;
  } | null;
  const endpoint = body?.endpoint;
  if (typeof endpoint !== "string") {
    return NextResponse.json({ error: "endpoint_required" }, { status: 400 });
  }
  deleteSubscription(endpoint);
  return NextResponse.json({ ok: true });
}
