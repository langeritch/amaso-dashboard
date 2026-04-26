import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getSession, listEvents } from "@/lib/recording";
import { listTabsForUser } from "@/lib/browser-stream";
import type { StoredRecordingEvent } from "@/types/recording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LOOKBACK_MS = 5 * 60_000;
const MAX_EVENTS_PER_TAB = 100;

/**
 * GET /api/recording/sessions/[id]/state?since=<ms>
 *
 * Cheap polling endpoint for an external AI assistant. Returns the
 * user's current LiveBrowser tab list joined with recent extension
 * events grouped per tab (matched by URL). Events on URLs that no
 * current tab is on land in `orphanedEvents` — useful for "user
 * navigated away" context without losing the trail.
 *
 * The pixel screencast is intentionally not part of this — the
 * extension's structured event log is richer and lighter for an LLM.
 * For deeper page content (accessibility tree, visible text), call
 * the on-demand snapshot endpoint per tab.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id: sessionId } = await ctx.params;

  const session = getSession(sessionId, auth.user.id);
  if (!session) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const sinceMs = sinceParam != null ? Number(sinceParam) : NaN;
  const since = Number.isFinite(sinceMs)
    ? sinceMs
    : Date.now() - DEFAULT_LOOKBACK_MS;

  const allEvents = listEvents(sessionId).filter((e) => e.timestamp >= since);

  // Group events by URL (ignoring fragments — same-page hash changes
  // shouldn't split the bucket). The tab list comes from the live
  // headless Chromium; if no LiveBrowser is up we still return events
  // grouped by URL so the AI gets something useful even when the user
  // closed the viewer.
  const liveTabs = listTabsForUser(auth.user.id);
  const stripHash = (u: string) => u.split("#")[0];
  const eventsByUrl = new Map<string, StoredRecordingEvent[]>();
  for (const ev of allEvents) {
    const key = stripHash(ev.url);
    const arr = eventsByUrl.get(key) ?? [];
    arr.push(ev);
    eventsByUrl.set(key, arr);
  }

  const matchedUrls = new Set<string>();
  const tabs = (liveTabs?.tabs ?? []).map((t) => {
    const key = stripHash(t.url);
    matchedUrls.add(key);
    const events = eventsByUrl.get(key) ?? [];
    return {
      tabId: t.tabId,
      url: t.url,
      title: t.title,
      active: t.active,
      eventCount: events.length,
      // Newest first — most useful when the AI scans the head.
      recentEvents: events.slice(-MAX_EVENTS_PER_TAB).reverse(),
    };
  });

  const orphanedEvents: StoredRecordingEvent[] = [];
  for (const [key, evs] of eventsByUrl) {
    if (matchedUrls.has(key)) continue;
    for (const ev of evs) orphanedEvents.push(ev);
  }
  orphanedEvents.sort((a, b) => b.timestamp - a.timestamp);

  return NextResponse.json({
    sessionId: session.id,
    sessionStatus: session.status,
    now: Date.now(),
    since,
    liveBrowser: liveTabs != null,
    tabs,
    orphanedEvents: orphanedEvents.slice(0, MAX_EVENTS_PER_TAB),
  });
}
