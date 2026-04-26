import { NextRequest, NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { startCall, TelegramVoiceUnavailable } from "@/lib/telegram-voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CallBody {
  user_id?: number;
  phone?: string;
}

export async function POST(req: NextRequest) {
  // Calling someone's real phone is admin-only. The shared-secret
  // token in telegram-voice enforces the same thing at the Python
  // layer, but gating here keeps clients out of the fetch path
  // entirely.
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  let body: CallBody = {};
  try {
    body = (await req.json()) as CallBody;
  } catch {
    /* empty body is fine — falls back to TARGET_PHONE in the service */
  }

  try {
    const status = await startCall(body);
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
