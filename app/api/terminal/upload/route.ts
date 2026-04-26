import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { UploadError, saveImage } from "@/lib/terminal-uploads";

export const dynamic = "force-dynamic";

// Paste / drop upload from TerminalPane. The client sends exactly one
// image per request; we write it under `data/terminal-uploads/<projectId>/`
// and return the absolute path so the client can paste it into the PTY.
export async function POST(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId || !canAccessProject(auth.user, projectId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  try {
    const abs = await saveImage(projectId, file);
    return NextResponse.json({ path: abs });
  } catch (err) {
    if (err instanceof UploadError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
