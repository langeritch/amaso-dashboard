import type { FillerSource, FillerItem } from "./types";
import { readHeartbeat } from "../heartbeat";

/**
 * Calendar / agenda filler — reads the user's heartbeat markdown and
 * surfaces commitments as TTS-friendly snippets.
 *
 * The heartbeat is a free-form bullet list, not a structured calendar,
 * so we lean on a few heuristics:
 *   - Keep lines that look like commitments / deadlines / events
 *     (date words, "today", "tomorrow", times, deadline-y verbs).
 *   - Drop pure section headings and bullets without dates.
 *   - Strip markdown noise (asterisks, dashes, leading bullets).
 *
 * Falls back to an empty list when the heartbeat is empty — the
 * registry treats that as "this source has nothing right now" and
 * the picker just returns null. Better than fabricating fake events.
 *
 * Userless: until the registry plumbs the requesting userId through
 * to fetch, this source reads heartbeat for user 1 (the dashboard's
 * single primary user). When multi-user filler matters we can swap
 * to a per-call userId via a factory; the registry already supports
 * that since fetchItems is async.
 */

const PRIMARY_USER_ID = 1;

const TIME_RE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/;
const DAY_RE = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
const DEADLINE_RE = /\b(deadline|due|by\s+\d|before\s+\d|at\s+\d|kickoff|meeting|call|standup|review|launch|deploy|interview)\b/i;

function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*[-*+•]\s*/, "")
    .replace(/^\s*#+\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeCommitment(line: string): boolean {
  if (line.length < 6 || line.length > 220) return false;
  return TIME_RE.test(line) || DAY_RE.test(line) || DEADLINE_RE.test(line);
}

function speakable(line: string): string {
  // Add a leading "On your agenda:" cue only when the line doesn't
  // already start with a verb — feels less robotic than prefixing
  // every line. Keep it at most one sentence.
  const cleaned = stripMarkdown(line);
  return cleaned.endsWith(".") ? cleaned : `${cleaned}.`;
}

export const calendarSource: FillerSource = {
  id: "calendar-heartbeat",
  async fetchItems(): Promise<FillerItem[]> {
    let body: string;
    try {
      body = readHeartbeat(PRIMARY_USER_ID);
    } catch {
      return [];
    }
    if (!body) return [];
    const lines = body.split(/\r?\n/);
    const items: FillerItem[] = [];
    for (let i = 0; i < lines.length; i++) {
      const cleaned = stripMarkdown(lines[i]);
      if (!cleaned) continue;
      if (!looksLikeCommitment(cleaned)) continue;
      items.push({
        // Index-stable id — the heartbeat changes throughout the
        // day, so a content-hash would dedup across sessions in a
        // surprising way. Position-keyed means a re-edited list
        // gets fresh dedup, which matches how this content turns
        // over.
        id: `line-${i}`,
        sourceId: "calendar-heartbeat",
        text: speakable(cleaned),
      });
      if (items.length >= 20) break;
    }
    return items;
  },
};
