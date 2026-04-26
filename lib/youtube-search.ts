import YouTube from "youtube-sr";

/**
 * Shared YouTube search helper used by the /api/youtube/search HTTP
 * route AND the youtube_search MCP tool, so results are identical
 * either way (same parsing, same field names, same fallbacks). Both
 * callers handle auth and error shaping on their own.
 */

export interface YouTubeSearchResult {
  id: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
  url: string;
}

export const DEFAULT_SEARCH_LIMIT = 5;

export async function searchYouTube(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<YouTubeSearchResult[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];
  // youtube-sr returns a mix of Video / Playlist / Channel objects
  // despite the type filter, so we still have to validate per-item.
  const raw = await YouTube.search(cleaned, { limit, type: "video" });
  const results: YouTubeSearchResult[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const id = typeof v.id === "string" ? v.id : null;
    const title = typeof v.title === "string" ? v.title : null;
    if (!id || !title) continue;

    const durMs = typeof v.duration === "number" ? v.duration : 0;
    const durationSec = durMs > 0 ? Math.round(durMs / 1000) : null;

    let thumbnailUrl: string | null = null;
    const t = v.thumbnail as { url?: unknown } | undefined;
    if (t && typeof t.url === "string") {
      thumbnailUrl = t.url;
    } else {
      // youtube-sr occasionally omits the thumbnail object; hqdefault
      // is always reachable from the id, so we fall back deterministically
      // instead of shipping a null the UI would have to render around.
      thumbnailUrl = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    }

    const channel =
      v.channel && typeof v.channel === "object" && "name" in v.channel
        ? String(v.channel.name ?? "") || null
        : null;

    results.push({
      id,
      title,
      channel,
      durationSec,
      thumbnailUrl,
      url: `https://www.youtube.com/watch?v=${id}`,
    });
    if (results.length >= limit) break;
  }
  return results;
}

export interface YouTubeVideoMeta {
  title: string | null;
  author: string | null;
  thumbnailUrl: string | null;
}

/**
 * Resolve title / author / thumbnail for a known video id without a
 * full search. Used by youtube_play / youtube_enqueue when the caller
 * gave us a video_id or URL but no title — the now-playing card would
 * otherwise render "untitled video". oEmbed is the cheapest reliable
 * source: no API key, ~200 ms, public for any non-private video.
 *
 * Returns nulls (never throws) on any failure — the caller falls back
 * to whatever it already has, and playback proceeds either way.
 */
export async function fetchYouTubeMeta(videoId: string): Promise<YouTubeVideoMeta> {
  const empty: YouTubeVideoMeta = { title: null, author: null, thumbnailUrl: null };
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return empty;
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const ctl = AbortSignal.timeout(4000);
    const res = await fetch(url, { signal: ctl });
    if (!res.ok) return empty;
    const data = (await res.json()) as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown };
    return {
      title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : null,
      author: typeof data.author_name === "string" && data.author_name.trim() ? data.author_name.trim() : null,
      thumbnailUrl:
        typeof data.thumbnail_url === "string" && data.thumbnail_url.trim()
          ? data.thumbnail_url.trim()
          : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return empty;
  }
}
