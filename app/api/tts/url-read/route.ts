import { NextRequest } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { getKokoroPort } from "@/lib/kokoro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Article URL → speech. Fetches the page server-side (browser CORS
 * would block it), pulls the visible text out of the HTML with a
 * deliberately dumb extractor, and pipes it through Kokoro.
 *
 * The drawer's "paste a URL" flow uses this for any non-YouTube URL.
 * YouTube links go through the existing /api/youtube/state enqueue
 * path instead — they're music, not text.
 *
 * Body: { url: string, maxChars?: number, voice?, speed?, lang? }
 * Response: audio/wav stream (same shape as /api/tts), or 4xx/5xx
 * with a plain-text error.
 *
 * Limits: page fetch is capped to ~2 MB and 8 s; extracted text is
 * truncated to MAX_READ_CHARS so a 100k-word essay doesn't trigger
 * a 30-minute synth. The drawer surfaces the truncation so the user
 * knows their article got clipped.
 */

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_READ_CHARS_DEFAULT = 4_000;
const MAX_READ_CHARS_HARD_CAP = 12_000;

function extractReadableText(html: string): string {
  // Strip script/style blocks first so their contents don't leak into
  // the visible text. Then drop tags and decode the most common
  // entities. Not Readability-grade, but good enough for "speak the
  // gist of this blog post" — the user can always paste cleaner text
  // directly via /tts if this misses.
  let body = html;
  body = body.replace(/<script[\s\S]*?<\/script>/gi, " ");
  body = body.replace(/<style[\s\S]*?<\/style>/gi, " ");
  body = body.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  body = body.replace(/<!--[\s\S]*?-->/g, " ");
  // Prefer <article>/<main> if present — typical article pages wrap
  // their real content in one of these and bury it under nav/header
  // chrome. Match is non-greedy, first hit wins.
  const articleMatch =
    body.match(/<article[\s\S]*?<\/article>/i) ||
    body.match(/<main[\s\S]*?<\/main>/i);
  if (articleMatch) body = articleMatch[0];
  body = body.replace(/<[^>]+>/g, " ");
  body = body
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  body = body.replace(/\s+/g, " ").trim();
  return body;
}

export async function POST(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  let body: {
    url?: unknown;
    maxChars?: unknown;
    voice?: unknown;
    speed?: unknown;
    lang?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) return new Response("url required", { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return new Response("invalid url", { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new Response("only http/https urls allowed", { status: 400 });
  }

  const requestedMax =
    typeof body.maxChars === "number" && Number.isFinite(body.maxChars)
      ? Math.floor(body.maxChars)
      : MAX_READ_CHARS_DEFAULT;
  const maxChars = Math.max(
    200,
    Math.min(MAX_READ_CHARS_HARD_CAP, requestedMax),
  );

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let pageRes: Response;
  try {
    pageRes = await fetch(parsed.toString(), {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AmasoTTS/1.0; +https://amaso.dev)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (err) {
    clearTimeout(timer);
    return new Response(`fetch failed: ${String(err).slice(0, 200)}`, {
      status: 502,
    });
  }
  clearTimeout(timer);

  if (!pageRes.ok) {
    return new Response(
      `upstream returned ${pageRes.status}`,
      { status: 502 },
    );
  }
  const contentType = pageRes.headers.get("content-type") ?? "";
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml")
  ) {
    return new Response(
      `unsupported content-type: ${contentType.slice(0, 80)}`,
      { status: 415 },
    );
  }

  // Stream the body manually so we can stop reading at MAX_PAGE_BYTES
  // — a multi-MB feed page would otherwise blow out memory before we
  // even reach the extractor.
  const reader = pageRes.body?.getReader();
  if (!reader) {
    return new Response("upstream returned empty body", { status: 502 });
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_PAGE_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    return new Response(`read failed: ${String(err).slice(0, 200)}`, {
      status: 502,
    });
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  const html = new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );

  const text = extractReadableText(html);
  if (!text) {
    return new Response("no readable text on page", { status: 422 });
  }
  const truncated = text.length > maxChars;
  const synthText = truncated ? text.slice(0, maxChars) : text;

  // Pipe through Kokoro identically to /api/tts. We re-implement the
  // POST here rather than hop through that route so the network has
  // one fewer link to break under load and we can return a single
  // streamed audio response straight to the caller.
  const payload: Record<string, unknown> = { text: synthText };
  if (typeof body.voice === "string") payload.voice = body.voice;
  if (typeof body.speed === "number") payload.speed = body.speed;
  if (typeof body.lang === "string") payload.lang = body.lang;

  const port = getKokoroPort();
  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${port}/synth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (err) {
    return new Response(
      `kokoro sidecar unreachable: ${String(err).slice(0, 120)}`,
      { status: 502 },
    );
  }
  if (!upstream.ok) {
    const msg = await upstream.text().catch(() => "synth failed");
    return new Response(msg, { status: upstream.status });
  }
  const ab = await upstream.arrayBuffer();
  // Surface truncation + final char count to the caller via headers so
  // the drawer can show a "(read first N chars)" hint without a
  // separate metadata request.
  return new Response(ab, {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(ab.byteLength),
      "Cache-Control": "no-store",
      "X-Amaso-Source-URL": parsed.toString(),
      "X-Amaso-Read-Chars": String(synthText.length),
      "X-Amaso-Truncated": truncated ? "1" : "0",
    },
  });
}
