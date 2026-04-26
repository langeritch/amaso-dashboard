/**
 * Shared types for the dashboard-native filler content system.
 *
 * Contract for new sources: implement `FillerSource`, register it
 * in `registry.ts` against one or more modes. The registry handles
 * dedup + session tracking so sources only have to worry about
 * "give me the current pool of items" — no state of their own.
 */

import type { FillerMode } from "../filler-mode";

export interface FillerItem {
  /** Stable id, unique within a source. Combined with sourceId
   *  before dedup so two sources can use the same numeric ids
   *  without colliding. */
  id: string;
  /** Human-readable text spoken by TTS. Keep it tight — these are
   *  thinking-time fillers, not lectures. ~1–2 sentences is ideal. */
  text: string;
  /** Origin source (e.g. "fun-facts", "bbc-rss"). Surfaced in the
   *  API response so a future UI can attribute or filter. */
  sourceId: string;
}

export interface FillerSource {
  /** Lower-case kebab id, used for dedup keys. Stable across deploys. */
  id: string;
  /** Returns the current item pool. Sources are free to fetch fresh
   *  data on every call (RSS) or return a static list (curated facts).
   *  Throwing is non-fatal — the registry just skips failed sources
   *  on this turn. */
  fetchItems(): Promise<FillerItem[]>;
}

export type { FillerMode };
