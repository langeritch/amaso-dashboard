/**
 * Central registry for media sources used by the spar media drawer.
 *
 * Each entry is one of three kinds, picked by `type`:
 *   - "search": pluggable search backends. The drawer renders a search
 *     bar per entry; submitting calls `search(query)` and renders the
 *     returned rows. Clicking a row fires `onSelect(result, ctx)`.
 *   - "url": URL-paste handlers. When the user pastes a URL, the
 *     drawer asks each entry whether `matches(url)` and dispatches to
 *     the first match. Order is significant — list specific handlers
 *     before catch-alls (e.g. youtube before "any url → tts").
 *   - "toggle": single-press buttons. The drawer renders these as
 *     filler-mode quick-toggles. `apply(ctx)` runs the side effect;
 *     `isActive(ctx)` returns whether the entry should render
 *     highlighted.
 *
 * Adding a new media source means appending to MEDIA_SOURCES — the
 * drawer picks it up automatically because the section components
 * iterate by type. The drawer never knows about specific sources by
 * id; it only consumes the shape.
 *
 * Why a flat array over a discriminated record map: the drawer
 * preserves insertion order so the operator can prioritise the
 * common case (YouTube search > pluggable add-ons; YouTube URLs >
 * generic article TTS). A keyed object would force an arbitrary
 * sort.
 */

import type { LucideIcon } from "lucide-react";

/** Shared search-result row. Concrete sources can extend this in
 *  practice (extra metadata fields), but the drawer only renders
 *  these four. */
export interface MediaSearchResult {
  id: string;
  title: string;
  /** Free-form line under the title (channel name, source, "5:32"). */
  subtitle: string | null;
  /** Square or 16:9 thumbnail. null → drawer renders a fallback icon. */
  thumbnailUrl: string | null;
  /** Carrier for backend-specific fields a source needs in onSelect.
   *  Opaque to the drawer; typed back inside the source's own
   *  callbacks via `as`. */
  payload: unknown;
}

/** Callbacks every source can use to act on the spar state. The
 *  drawer wires these up from SparContext + local helpers; sources
 *  never reach into context themselves so they stay portable. */
export interface MediaSourceContext {
  /** Add a YouTube video to the queue (or promote it straight to
   *  now-playing if nothing is selected). Same shape as
   *  SparContext.youtubeEnqueue — exposed here so sources can fire
   *  it without importing the context. */
  enqueueYoutube: (item: {
    videoId: string;
    title: string | null;
    thumbnailUrl: string | null;
    durationSec: number | null;
  }) => void;
  /** Apply a filler mode. Wraps a POST to /api/spar/filler-mode. */
  setFillerMode: (mode: string) => Promise<void>;
  /** Currently-active filler mode, polled by the drawer. Used by
   *  toggle entries to highlight themselves. */
  currentFillerMode: string | null;
  /** Speak an arbitrary URL through the article-TTS pipeline. */
  speakUrl: (url: string) => Promise<void>;
  /** Append a notice to the chat transcript (parity with /youtube
   *  slash command — confirms an action without round-tripping the
   *  model). */
  appendNotice: (text: string) => void;
}

export interface SearchMediaSource {
  id: string;
  type: "search";
  label: string;
  icon: LucideIcon;
  placeholder: string;
  search: (query: string) => Promise<MediaSearchResult[]>;
  onSelect: (result: MediaSearchResult, ctx: MediaSourceContext) => void;
}

export interface UrlMediaSource {
  id: string;
  type: "url";
  label: string;
  icon: LucideIcon;
  /** Return true if this handler claims the URL. The drawer dispatches
   *  to the first matching handler in registry order. */
  matches: (url: URL) => boolean;
  handle: (url: URL, ctx: MediaSourceContext) => Promise<void>;
}

export interface ToggleMediaSource {
  id: string;
  type: "toggle";
  label: string;
  icon: LucideIcon;
  /** Filler-mode value posted when the toggle is pressed. */
  fillerMode: string;
  /** Optional second filler-mode that should also count this toggle
   *  as "active" — e.g. the calendar mode is also a "spoken" toggle.
   *  null → strict equality with fillerMode. */
  matchModes?: readonly string[];
}

export type MediaSource =
  | SearchMediaSource
  | UrlMediaSource
  | ToggleMediaSource;

// ---------------------------------------------------------------------------
// Concrete sources
// ---------------------------------------------------------------------------
//
// Imports kept inside this file so adding a source is one place to
// edit. Lucide icon names are passed through; the drawer renders them
// as JSX components.

import { Newspaper, ListMusic, Search, VolumeX } from "lucide-react";

/** Server-side YouTube search response shape — must match
 *  /api/youtube/search/route.ts. Kept in sync by hand because the
 *  search route returns a `{ query, results }` envelope around the
 *  same `YouTubeSearchResult` lib-level type. */
interface YouTubeSearchHttpResult {
  id: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  thumbnailUrl: string;
  url: string;
}

const youtubeSearchSource: SearchMediaSource = {
  id: "youtube-search",
  type: "search",
  label: "YouTube",
  icon: Search,
  placeholder: "Search YouTube…",
  search: async (query) => {
    const url = `/api/youtube/search?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`search failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      results?: YouTubeSearchHttpResult[];
    };
    return (data.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      subtitle: [r.channel, formatDuration(r.durationSec)]
        .filter(Boolean)
        .join(" · "),
      thumbnailUrl: r.thumbnailUrl ?? null,
      payload: r,
    }));
  },
  onSelect: (result, ctx) => {
    const r = result.payload as YouTubeSearchHttpResult;
    ctx.enqueueYoutube({
      videoId: r.id,
      title: r.title,
      thumbnailUrl: r.thumbnailUrl,
      durationSec: r.durationSec,
    });
    ctx.appendNotice(`Queued: ${r.title}`);
  },
};

/** Match `youtube.com/watch?v=…`, `youtu.be/…`, `m.youtube.com/…`,
 *  and `youtube.com/shorts/…`. The drawer falls back to the article
 *  reader for everything else, including youtube.com pages that
 *  aren't a video URL (channels, search) — those wouldn't yield a
 *  playable id anyway. */
function extractYoutubeVideoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\//, "").split("/")[0];
    return id && id.length === 11 ? id : null;
  }
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const v = url.searchParams.get("v");
  if (v && v.length === 11) return v;
  const shortsMatch = url.pathname.match(/^\/shorts\/([\w-]{11})/);
  if (shortsMatch) return shortsMatch[1];
  return null;
}

const youtubeUrlSource: UrlMediaSource = {
  id: "youtube-url",
  type: "url",
  label: "YouTube link",
  icon: ListMusic,
  matches: (url) => extractYoutubeVideoId(url) !== null,
  handle: async (url, ctx) => {
    const id = extractYoutubeVideoId(url);
    if (!id) return;
    ctx.enqueueYoutube({
      videoId: id,
      title: null,
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      durationSec: null,
    });
    ctx.appendNotice(`Queued YouTube link.`);
  },
};

const articleUrlSource: UrlMediaSource = {
  id: "article-url",
  type: "url",
  label: "Article (read aloud)",
  icon: Newspaper,
  // Catch-all — last in the URL handlers so YouTube still wins for
  // youtube.com links.
  matches: () => true,
  handle: async (url, ctx) => {
    await ctx.speakUrl(url.toString());
  },
};

const fillerToggles: ToggleMediaSource[] = [
  {
    id: "mode-news",
    type: "toggle",
    label: "News",
    icon: Newspaper,
    fillerMode: "news",
  },
  {
    id: "mode-fun-facts",
    type: "toggle",
    label: "Fun Facts",
    icon: Search,
    fillerMode: "fun-facts",
  },
  {
    id: "mode-quiet",
    type: "toggle",
    label: "Quiet",
    icon: VolumeX,
    fillerMode: "quiet",
  },
  // "off" intentionally removed — the speaker toggle in MediaDrawer
  // is the single user-facing way to silence assistant speech, and
  // having both controls duplicated which one actually disables
  // anything. Legacy persisted "off" values are normalised to
  // "quiet" on read (see lib/filler-mode.ts).
];

/** The single registry the drawer iterates. Order is preserved when
 *  rendering, so place common cases first. */
export const MEDIA_SOURCES: readonly MediaSource[] = [
  youtubeSearchSource,
  youtubeUrlSource,
  articleUrlSource,
  ...fillerToggles,
];

export function mediaSourcesByType<T extends MediaSource["type"]>(
  type: T,
): readonly Extract<MediaSource, { type: T }>[] {
  return MEDIA_SOURCES.filter(
    (s): s is Extract<MediaSource, { type: T }> => s.type === type,
  );
}

function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
