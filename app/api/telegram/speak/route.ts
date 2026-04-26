import { NextRequest, NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { speak, TelegramVoiceUnavailable } from "@/lib/telegram-voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SpeakBody {
  text?: string;
  voice?: string;
  speed?: number;
}

export async function POST(req: NextRequest) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  let body: SpeakBody;
  try {
    body = (await req.json()) as SpeakBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  try {
    const result = await speak({ text, voice: body.voice, speed: body.speed });
    return NextResponse.json(result);
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
