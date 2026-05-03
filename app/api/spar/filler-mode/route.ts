import { NextRequest, NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import {
  USER_SELECTABLE_MODES,
  getFillerConfig,
  setFillerMode,
  type FillerMode,
} from "@/lib/filler-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const config = await getFillerConfig();
  return NextResponse.json(config);
}

interface PostBody {
  mode?: unknown;
  urlOrTopic?: unknown;
}

export async function POST(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // "youtube" is intentionally NOT in USER_SELECTABLE_MODES — it
  // toggles automatically when a video starts/stops via the
  // enableYouTubeMode / disableYouTubeMode helpers. A direct POST
  // mode:"youtube" would skip the previousMode snapshot and leave
  // the user stuck after the next stop.
  if (
    typeof body.mode !== "string" ||
    !(USER_SELECTABLE_MODES as readonly string[]).includes(body.mode)
  ) {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }

  const hint =
    typeof body.urlOrTopic === "string" && body.urlOrTopic.trim()
      ? body.urlOrTopic.trim()
      : undefined;

  await setFillerMode(body.mode as FillerMode, hint);
  return NextResponse.json({ ok: true, mode: body.mode, urlOrTopic: hint ?? null });
}
