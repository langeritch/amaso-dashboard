import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { UploadError, issueShareToken, saveImage } from "@/lib/terminal-uploads";

export const dynamic = "force-dynamic";

// Target for the PWA Web Share API. iOS opens the share sheet after a
// screenshot → "Amaso" → POSTs the image here. We don't know which
// project yet, so we stash the file in the `_shared` bucket, mint a
// one-shot token, and bounce back to `/?share=<token>`. ShareIngress
// picks the token up client-side and hands it to the next terminal.
export async function POST(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.redirect(new URL("/", req.url));
  // Different share sheets pick different field names; accept the usual
  // suspects plus any image-typed file in the form.
  let file: File | null = null;
  for (const key of ["file", "files", "image", "photo"]) {
    const v = form.get(key);
    if (v instanceof File && v.size > 0) {
      file = v;
      break;
    }
  }
  if (!file) {
    for (const entry of form.values()) {
      if (entry instanceof File && entry.size > 0 && entry.type.startsWith("image/")) {
        file = entry;
        break;
      }
    }
  }
  if (!file) return NextResponse.redirect(new URL("/", req.url));
  try {
    const abs = await saveImage("_shared", file);
    const token = issueShareToken(abs);
    return NextResponse.redirect(new URL(`/?share=${token}`, req.url));
  } catch (err) {
    if (err instanceof UploadError) {
      return NextResponse.redirect(
        new URL(`/?shareError=${encodeURIComponent(err.message)}`, req.url),
      );
    }
    throw err;
  }
}
