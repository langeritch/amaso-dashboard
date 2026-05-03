import { NextRequest, NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { searchYouTube, DEFAULT_SEARCH_LIMIT } from "@/lib/youtube-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight YouTube search — scrapes via youtube-sr, no API key.
 * The actual parsing lives in `lib/youtube-search.ts` so the MCP
 * tool returns identical shapes (same picks, same fallbacks).
 */

const MAX_QUERY_LEN = 200;

export async function GET(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const query = (req.nextUrl.searchParams.get("query") ?? "").trim();
  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }
  if (query.length > MAX_QUERY_LEN) {
    return NextResponse.json(
      { error: `query too long (>${MAX_QUERY_LEN})` },
      { status: 400 },
    );
  }

  try {
    const results = await searchYouTube(query, DEFAULT_SEARCH_LIMIT);
    return NextResponse.json(
      { query, results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: `search failed: ${String(err).slice(0, 200)}` },
      { status: 502 },
    );
  }
}
