import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import {
  getStatus,
  TelegramVoiceUnavailable,
} from "@/lib/telegram-voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  try {
    const status = await getStatus();
    return NextResponse.json(status);
  } catch (err) {
    if (err instanceof TelegramVoiceUnavailable) {
      return NextResponse.json(
        { state: "offline", detail: err.message },
        { status: 200 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }
}
