"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  RecordingSession,
  StoredRecordingEvent,
} from "@/types/recording";

export default function RecordingDetailClient({
  session,
  initialEvents,
}: {
  session: RecordingSession;
  initialEvents: StoredRecordingEvent[];
}) {
  const [events, setEvents] = useState(initialEvents);
  const [filter, setFilter] = useState<"all" | "flagged">(
    initialEvents.some((e) => e.needs_clarification && !e.clarification)
      ? "flagged"
      : "all",
  );
  const visible =
    filter === "flagged"
      ? events.filter((e) => e.needs_clarification && !e.clarification)
      : events;

  async function saveClarification(eventId: number, text: string) {
    const r = await fetch(
      `/api/recording/sessions/${session.id}/events/${eventId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clarification: text }),
      },
    );
    if (!r.ok) return;
    const j = (await r.json()) as { event: StoredRecordingEvent };
    setEvents((prev) => prev.map((e) => (e.id === j.event.id ? j.event : e)));
  }

  const flaggedOpen = events.filter(
    (e) => e.needs_clarification && !e.clarification,
  ).length;

  return (
    <main className="flex-1 overflow-y-auto bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <header className="mb-4 flex items-baseline gap-3">
          <Link
            href="/recording"
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            ← all recordings
          </Link>
          <span className="font-mono text-xs text-neutral-500">
            {session.id.slice(0, 8)}…
          </span>
          <span className="ml-auto text-xs text-neutral-500">
            {session.eventCount} events · {flaggedOpen} need clarification
          </span>
        </header>

        <div className="mb-4 flex items-center gap-2 border-b border-neutral-800 pb-3 text-xs">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`rounded-full px-3 py-1 ${
              filter === "all"
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-900"
            }`}
          >
            all
          </button>
          <button
            type="button"
            onClick={() => setFilter("flagged")}
            className={`rounded-full px-3 py-1 ${
              filter === "flagged"
                ? "bg-amber-500/20 text-amber-200"
                : "text-neutral-400 hover:bg-neutral-900"
            }`}
          >
            flagged ({flaggedOpen})
          </button>
        </div>

        {visible.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {filter === "flagged"
              ? "No flagged events. Either nothing was ambiguous or you've already explained them all."
              : "No events captured yet."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                onSave={(text) => void saveClarification(e.id, text)}
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function EventRow({
  event,
  onSave,
}: {
  event: StoredRecordingEvent;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(event.clarification ?? "");
  const flagged = event.needs_clarification;
  const resolved = flagged && !!event.clarification;
  return (
    <li
      className={`rounded-lg border px-3 py-2 ${
        flagged && !resolved
          ? "border-amber-500/40 bg-amber-950/20"
          : "border-neutral-800 bg-neutral-900/40"
      }`}
    >
      <div className="flex items-baseline gap-2 text-xs">
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
          {event.type}
        </span>
        <span className="font-mono text-[11px] text-neutral-500">
          {fmtTime(event.timestamp)}
        </span>
        <span className="truncate text-neutral-400">{event.url}</span>
      </div>
      <div className="mt-1 text-sm text-neutral-200">
        {summarize(event)}
      </div>
      {event.target?.selector && (
        <div className="mt-1 truncate font-mono text-[11px] text-neutral-500">
          {event.target.selector}
        </div>
      )}
      {flagged && (
        <div className="mt-2 flex flex-col gap-1">
          {event.clarification_reason && (
            <span className="text-[11px] text-amber-300/80">
              flagged: {event.clarification_reason}
            </span>
          )}
          <div className="flex items-start gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="What were you doing here?"
              className="flex-1 resize-y rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-700 focus:outline-none"
            />
            <button
              type="button"
              disabled={draft === (event.clarification ?? "")}
              onClick={() => onSave(draft)}
              className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:border-neutral-600 disabled:opacity-40"
            >
              save
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function summarize(e: StoredRecordingEvent): string {
  switch (e.type) {
    case "click":
      return `clicked ${e.target?.text ?? e.target?.tagName ?? "element"}`;
    case "input":
      return `typed "${truncate(e.value ?? "", 60)}" into ${
        e.target?.selector ?? "field"
      }`;
    case "submit":
      return `submitted ${e.target?.selector ?? "form"}`;
    case "navigation":
      return e.value ? `navigated from ${e.value}` : `loaded ${e.url}`;
    case "keydown":
      return `pressed ${e.value ?? "key"}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
