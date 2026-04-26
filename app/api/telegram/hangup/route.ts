import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { hangup, TelegramVoiceUnavailable } from "@/lib/telegram-voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  try {
    const status = await hangup();
    return NextResponse.json(status);
  } catch (err) {
    if (err instanceof TelegramVoiceUnavailable) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }
}
