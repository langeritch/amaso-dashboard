import type { FillerItem, FillerSource, FillerMode } from "./types";
import { funFactsSource } from "./fun-facts";
import { newsRssSource } from "./news";
import { calendarSource } from "./calendar";

/**
 * Mode → sources registry + per-user session dedup. The picker
 * returns the next unseen item for a given (userId, mode); when
 * every item has been served once it resets and starts over so the
 * stream never fully runs dry.
 *
 * Adding a source: implement `FillerSource`, import here, push it
 * into the array under the relevant mode. No other code change
 * required — the API endpoint reads through the registry, and
 * dedup keys auto-namespace by sourceId.
 *
 * Sessions: keyed by userId. We hold an in-memory Map; on a server
 * restart everyone starts fresh, which is the right default for a
 * single-machine dashboard. A cap on the served-set size guards
 * against unbounded growth in long-lived sessions.
 */

const SOURCES_BY_MODE: Partial<Record<FillerMode, FillerSource[]>> = {
  "fun-facts": [funFactsSource],
  calendar: [calendarSource],
  news: [newsRssSource],
};

const MAX_SERVED_PER_USER = 1024;

const servedByUser = new Map<number, Set<string>>();

function dedupKey(item: FillerItem): string {
  return `${item.sourceId}::${item.id}`;
}

function servedFor(userId: number): Set<string> {
  let set = servedByUser.get(userId);
  if (!set) {
    set = new Set();
    servedByUser.set(userId, set);
  }
  return set;
}

export function isModeSupported(mode: FillerMode): boolean {
  const sources = SOURCES_BY_MODE[mode];
  return !!sources && sources.length > 0;
}

export interface PickedFiller {
  text: string;
  itemId: string;
  sourceId: string;
  mode: FillerMode;
}

/**
 * Picks the next unseen item for the user under the requested mode.
 * Returns null when no source for that mode produced anything (e.g.
 * news fetch failed AND no other source under "news"; or the mode
 * isn't a TTS-content mode). Resets the served set when exhausted.
 *
 * Hint (`urlOrTopic`) is forwarded to sources that opt into it —
 * none use it yet, so the param is reserved.
 */
export async function pickNextFillerItem(
  userId: number,
  mode: FillerMode,
  _hint?: string,
): Promise<PickedFiller | null> {
  const sources = SOURCES_BY_MODE[mode];
  if (!sources || sources.length === 0) return null;

  // Gather items from every source for this mode, in registration
  // order. A failing source is skipped silently — its absence is
  // the failure mode (caller falls back to silence).
  const pool: FillerItem[] = [];
  for (const s of sources) {
    try {
      const items = await s.fetchItems();
      for (const it of items) pool.push(it);
    } catch {
      /* skip — registry is best-effort */
    }
  }
  if (pool.length === 0) return null;

  const served = servedFor(userId);
  let pick = pool.find((it) => !served.has(dedupKey(it)));
  if (!pick) {
    // Every item has been heard this session — reset and start
    // over. Cheaper than letting the served-set balloon with
    // stale ids when sources have small static pools.
    served.clear();
    pick = pool[0];
  }
  served.add(dedupKey(pick));
  // Hard cap so a session that runs for hours under a churning RSS
  // feed doesn't bloat memory. Forget the oldest entry by clearing
  // — losing recent dedup is cheaper than tracking insertion order.
  if (served.size > MAX_SERVED_PER_USER) served.clear();

  return {
    text: pick.text,
    itemId: pick.id,
    sourceId: pick.sourceId,
    mode,
  };
}

/** Drop a user's session-dedup state. Used by an explicit reset
 *  endpoint and by the SparProvider on call-end. */
export function resetFillerSession(userId: number): void {
  servedByUser.delete(userId);
}
