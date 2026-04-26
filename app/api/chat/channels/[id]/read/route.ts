import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { canUseChannel, markChannelRead } from "@/lib/chat";

export const dynamic = "force-dynamic";

/** Mark a channel as read up to `ts` (defaults to now). */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  const channelId = Number(id);
  if (!Number.isFinite(channelId)) {
    return NextResponse.json({ error: "bad_channel" }, { status: 400 });
  }
  if (!canUseChannel(auth.user, channelId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const json = (await req.json().catch(() => ({}))) as { ts?: number };
  const ts =
    typeof json.ts === "number" && Number.isFinite(json.ts) ? json.ts : undefined;

  markChannelRead(auth.user.id, channelId, ts);
  return NextResponse.json({ ok: true });
}
