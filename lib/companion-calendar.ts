/**
 * Apple Calendar sync via the companion app (Item 10, remark #496).
 *
 * Privacy-friendly, read-only: instead of iCloud CalDAV (needs an
 * app-specific password stored server-side), we ask the companion app
 * running on the user's Mac to shell out to `icalBuddy` and read the
 * local Calendar.app database. The dashboard polls this on an interval
 * and shows the events in the today view.
 *
 * Requires `icalBuddy` on the Mac (`brew install ical-buddy`) and a
 * connected companion device. Everything degrades gracefully: no device,
 * icalBuddy missing, or unparseable output → empty event list, never a
 * throw that could break a panel.
 *
 * COMMAND + FORMAT NOTE: we pin icalBuddy's bullet and property order so
 * the parser has a stable shape to read. The exact flag behaviour can
 * vary across icalBuddy versions, so parseIcalBuddyOutput is deliberately
 * tolerant (see its doc) and the format should be eyeballed against the
 * installed icalBuddy on first run.
 */

import {
  isCompanionConnected,
  sendCompanionCommandToDevice,
} from "./companion-ws";

export interface CalendarEvent {
  title: string;
  /** Raw datetime line as icalBuddy printed it (human-readable). */
  when: string;
  location: string | null;
}

// We pin a distinctive bullet ("* ") and ask for datetime,title,location
// in that order, notes off, no calendar names, no extra prop names. The
// window is today through +7 days.
export const ICALBUDDY_CMD =
  'icalBuddy -nc -npn -b "* " -po "datetime,title,location" ' +
  '-iep "datetime,title,location" eventsToday+7';

/**
 * Parse icalBuddy's default text output into events. Tolerant by design:
 *
 *  - An event starts at a line beginning with the bullet ("* ") OR a
 *    non-indented non-empty line that isn't obviously a property.
 *  - Following INDENTED lines are that event's properties. A line that
 *    looks like a date/time range becomes `when`; a "location: x" line
 *    (or a remaining indented line) becomes `location`.
 *  - Blank lines separate events.
 *
 * Unknown / malformed lines are skipped rather than throwing. Returns []
 * for empty or unrecognisable input.
 */
export function parseIcalBuddyOutput(raw: string): CalendarEvent[] {
  if (!raw || !raw.trim()) return [];
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const events: CalendarEvent[] = [];
  let cur: CalendarEvent | null = null;

  // Matches things like "5 May 2026 at 10:00 - 11:00", "today at 9:00",
  // "Apr 5, 2026 at 10:00 AM - 11:00 AM". Loose on purpose.
  const dateish =
    /\b(\d{1,2}:\d{2}|today|tomorrow|\d{1,2}\s+\w+\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4})\b/i;

  const flush = () => {
    if (cur && cur.title) events.push(cur);
    cur = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const isIndented = /^\s/.test(line);
    const bulletMatch = line.match(/^\*\s+(.*)$/);

    if (bulletMatch || (!isIndented && !cur)) {
      // New event title row.
      flush();
      const title = (bulletMatch ? bulletMatch[1] : line).trim();
      cur = { title, when: "", location: null };
      continue;
    }

    // Property line for the current event.
    if (cur) {
      const text = line.trim();
      const locMatch = text.match(/^location:\s*(.+)$/i);
      if (locMatch) {
        cur.location = locMatch[1].trim();
      } else if (!cur.when && dateish.test(text)) {
        cur.when = text;
      } else if (!cur.location) {
        // Leftover indented line — best-effort location.
        cur.location = text;
      }
    }
  }
  flush();
  return events;
}

/**
 * Fetch upcoming Apple Calendar events for a user via their connected
 * companion Mac. Returns { ok, events, error? }. Never throws.
 */
export async function fetchCompanionCalendar(
  userId: number,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; events: CalendarEvent[]; error?: string }> {
  if (!isCompanionConnected(userId)) {
    return { ok: false, events: [], error: "no_companion_connected" };
  }
  try {
    const ack = await sendCompanionCommandToDevice(
      userId,
      { type: "shell.exec", cmd: ICALBUDDY_CMD },
      null,
      timeoutMs,
    );
    if (!ack.ok) {
      return { ok: false, events: [], error: ack.error || "exec_failed" };
    }
    const result = (ack.result ?? {}) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };
    if (result.exitCode && result.exitCode !== 0) {
      // icalBuddy not installed surfaces as a non-zero exit + stderr.
      const stderr = (result.stderr || "").toLowerCase();
      const error =
        stderr.includes("not found") || stderr.includes("command not found")
          ? "icalbuddy_not_installed"
          : "exec_nonzero";
      return { ok: false, events: [], error };
    }
    return { ok: true, events: parseIcalBuddyOutput(result.stdout || "") };
  } catch (err) {
    return {
      ok: false,
      events: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
