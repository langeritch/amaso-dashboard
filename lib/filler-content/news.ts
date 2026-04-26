import type { FillerSource, FillerItem } from "./types";

/**
 * BBC World News RSS source — fetched on-demand, not cached.
 *
 * Per-call freshness is fine: filler is bounded by session dedup, so
 * we'd at most fetch once per thinking turn (typically <1/min).
 * BBC's RSS endpoint is unauthenticated, public, and tolerant of
 * frequent polling. If the fetch fails the registry just skips this
 * source for the turn — caller falls back to silence, which is what
 * "couldn't reach the news" should sound like anyway.
 *
 * Item shape: title + the first sentence of the description, joined.
 * The description tag in BBC RSS is a single short paragraph already,
 * so we don't need full HTML parsing — a tag-strip + collapse is
 * enough to get TTS-friendly text.
 */

const BBC_RSS_URL = "https://feeds.bbci.co.uk/news/world/rss.xml";
const FETCH_TIMEOUT_MS = 4_000;
const MAX_ITEMS = 12;

interface RawItem {
  guid: string;
  title: string;
  description: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function extract(xml: string, tag: string): string {
  const m = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  if (!m) return "";
  // Strip CDATA if present.
  const inner = m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  return decodeEntities(stripTags(inner));
}

function parseRss(xml: string): RawItem[] {
  const out: RawItem[] = [];
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = extract(block, "title");
    const description = extract(block, "description");
    const guid = extract(block, "guid") || title || description.slice(0, 40);
    if (!title) continue;
    out.push({ guid, title, description });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export const newsRssSource: FillerSource = {
  id: "bbc-rss",
  async fetchItems(): Promise<FillerItem[]> {
    let res: Response;
    try {
      res = await fetch(BBC_RSS_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // Public RSS — let any cache layer collapse repeats.
        cache: "no-store",
        headers: { "user-agent": "amaso-dashboard/filler" },
      });
    } catch {
      return [];
    }
    if (!res.ok) return [];
    let xml: string;
    try {
      xml = await res.text();
    } catch {
      return [];
    }
    const raw = parseRss(xml);
    return raw.map((r) => ({
      id: r.guid,
      sourceId: "bbc-rss",
      // Title alone reads better via TTS than title-plus-description
      // for most BBC feeds — descriptions often start with "By Joe
      // Bloggs, BBC News" boilerplate. Append the description only
      // when it adds genuinely new info.
      text:
        r.description &&
        !r.description.toLowerCase().startsWith(r.title.toLowerCase()) &&
        !/^by\s/i.test(r.description)
          ? `${r.title}. ${r.description}`
          : r.title,
    }));
  },
};
