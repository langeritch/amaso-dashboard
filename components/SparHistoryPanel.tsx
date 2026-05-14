"use client";

import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import AssistantMarkdown from "./AssistantMarkdown";
import { useSpar } from "./SparContext";

/**
 * Layer 5 — read-only history browser. Lives inside SparSidebar
 * under the "History" tab. Two sub-tabs (By topic / By day) and a
 * detail screen for either a topic or a single day's transcript.
 *
 * Pure browsing UI: no edits, no deletes, no merges. The composer +
 * today's chat continue to live in the main spar pane; history is a
 * sibling read surface, not a replacement.
 */

type HistorySubTab = "topic" | "day";

interface TopicSummary {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  status: "active" | "archived";
  messageCount: number;
  lastActiveAt: number;
  createdAt: number;
}

interface DaySummary {
  date: string;
  activeConversationId: number | null;
  conversationIds: number[];
  messageCount: number;
  summary: string | null;
  topics: { id: number; slug: string; title: string }[];
}

interface HistoryMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls: unknown | null;
  createdAt: number;
}

type Detail = { kind: "day"; date: string; conversationId: number };

export default function SparHistoryPanel() {
  const { setMirrorTopic } = useSpar();
  const [sub, setSub] = useState<HistorySubTab>("topic");
  const [detail, setDetail] = useState<Detail | null>(null);

  if (detail?.kind === "day") {
    return (
      <DayDetail
        date={detail.date}
        conversationId={detail.conversationId}
        onBack={() => setDetail(null)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SubTabs active={sub} onChange={setSub} />
      {sub === "topic" ? (
        // Click on a topic row opens the read-only TopicMirrorView in
        // the main chat region. The mirror exposes its own "Ask about
        // this" button, which is the canonical promotion path to a
        // live conversation with the topic pill loaded. Mirrors the
        // PWA flow in components/mobile/history.tsx (TopicDetail ->
        // onScopeTopic).
        <TopicList
          onOpen={(t) => setMirrorTopic({ id: t.id, slug: t.slug, title: t.title })}
        />
      ) : (
        <DayList
          onOpen={(d) =>
            d.activeConversationId !== null &&
            setDetail({
              kind: "day",
              date: d.date,
              conversationId: d.activeConversationId,
            })
          }
        />
      )}
    </div>
  );
}

function SubTabs({
  active,
  onChange,
}: {
  active: HistorySubTab;
  onChange: (v: HistorySubTab) => void;
}) {
  const tabs: { id: HistorySubTab; label: string }[] = [
    { id: "topic", label: "By topic" },
    { id: "day", label: "By day" },
  ];
  return (
    <nav
      role="tablist"
      aria-label="history grouping"
      className="flex border-b border-neutral-800/70 bg-neutral-950/40"
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={`amaso-fx amaso-press relative flex flex-1 items-center justify-center px-3 py-2 text-[10px] uppercase tracking-[0.2em] transition-colors ${
              isActive
                ? "text-neutral-100"
                : "text-neutral-500 hover:bg-neutral-900/40 hover:text-neutral-300"
            }`}
          >
            <span>{t.label}</span>
            <span
              aria-hidden
              className={`absolute inset-x-3 bottom-0 h-[2px] rounded-full transition-colors ${
                isActive ? "bg-orange-400" : "bg-transparent"
              }`}
            />
          </button>
        );
      })}
    </nav>
  );
}

function TopicList({ onOpen }: { onOpen: (t: TopicSummary) => void }) {
  const [items, setItems] = useState<TopicSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/spar/topics?limit=50")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { topics: TopicSummary[] }) => {
        if (!cancelled) setItems(d.topics ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Empty msg={`Couldn't load topics (${error}).`} />;
  if (items === null) return <LoadingHint />;
  if (items.length === 0) return <Empty msg="No topics yet. They appear as you chat." />;

  return (
    <ul className="amaso-fade-in min-h-0 flex-1 overflow-y-auto py-1">
      {items.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => onOpen(t)}
            className="amaso-fx group flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left hover:bg-neutral-900/60"
          >
            <div className="flex w-full items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-100">
                {t.title}
              </span>
              <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">
                {t.messageCount}
              </span>
            </div>
            <div className="flex w-full items-center gap-2 text-[10px] uppercase tracking-wider text-neutral-500">
              <span>{relativeTime(t.lastActiveAt)}</span>
              {t.status === "archived" && (
                <>
                  <span className="text-neutral-700">·</span>
                  <span>archived</span>
                </>
              )}
            </div>
            {t.summary && (
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-neutral-500">
                {t.summary}
              </p>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function DayList({ onOpen }: { onOpen: (d: DaySummary) => void }) {
  const [items, setItems] = useState<DaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    const term = search.trim();
    const url = term
      ? `/api/spar/days?limit=90&q=${encodeURIComponent(term)}`
      : "/api/spar/days?limit=90";
    const delay = term ? 300 : 0;
    const t = setTimeout(() => {
      setItems(null);
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { days: DaySummary[] }) => {
          if (!cancelled) setItems(d.days ?? []);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search]);

  if (error) return <Empty msg={`Couldn't load days (${error}).`} />;

  const noResults = items !== null && items.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="px-3 pt-2 pb-1">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search days..."
          className="w-full rounded border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-300 placeholder-neutral-600 outline-none focus:border-neutral-700"
        />
      </div>
      {items === null ? (
        <LoadingHint />
      ) : noResults ? (
        <Empty
          msg={search.trim() ? `No results for "${search.trim()}".` : "No conversation history yet."}
        />
      ) : (
        <ul className="amaso-fade-in min-h-0 flex-1 overflow-y-auto py-1">
          {items.map((d) => {
            const disabled = d.activeConversationId === null;
            return (
              <li key={d.date}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onOpen(d)}
                  className={`amaso-fx group flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left ${
                    disabled
                      ? "opacity-50"
                      : "hover:bg-neutral-900/60 active:bg-neutral-900/80"
                  }`}
                >
                  <div className="flex w-full items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-100">
                      {dayLabel(d.date)}
                    </span>
                    <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">
                      {d.messageCount}
                    </span>
                  </div>
                  {d.summary && (
                    <p className="line-clamp-2 text-[11px] leading-snug text-neutral-400">
                      {d.summary}
                    </p>
                  )}
                  {d.topics.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {d.topics.map((t) => (
                        <span
                          key={t.id}
                          className="rounded border border-neutral-800 bg-neutral-900/70 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400"
                        >
                          {t.title}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// TopicDetail (in-panel "peek" view) lives elsewhere now: clicking a
// topic row sets mirrorTopic on the spar context, which SparFullView
// reads to swap its text-mode chat region for <TopicMirrorView>. The
// mirror owns the topic transcript fetch + the "Ask about this"
// promotion button. Visual parity with the PWA TopicDetail in
// components/mobile/history.tsx is the goal of the swap.

function DayDetail({
  date,
  conversationId,
  onBack,
}: {
  date: string;
  conversationId: number;
  onBack: () => void;
}) {
  const [data, setData] = useState<{
    messages: HistoryMessage[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/spar/conversations/${conversationId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!cancelled) setData({ messages: d.messages ?? [] });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return (
    <DetailFrame title={dayLabel(date)} subtitle={null} onBack={onBack}>
      {error ? (
        <Empty msg={`Couldn't load day (${error}).`} />
      ) : data === null ? (
        <LoadingHint />
      ) : data.messages.length === 0 ? (
        <Empty msg="No messages on this day." />
      ) : (
        <MessageStream messages={data.messages} />
      )}
    </DetailFrame>
  );
}

function DetailFrame({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle: string | null;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-start gap-2 border-b border-neutral-800/70 px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="back"
          className="amaso-fx amaso-press flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 py-1">
          <div className="truncate text-sm text-neutral-100">{title}</div>
          {subtitle && (
            <div className="line-clamp-2 text-[11px] leading-snug text-neutral-500">
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function MessageStream({ messages }: { messages: HistoryMessage[] }) {
  return (
    <div className="amaso-fade-in min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.map((m) => (
        <MessageBubble key={m.id} m={m} />
      ))}
    </div>
  );
}

function MessageBubble({ m }: { m: HistoryMessage }) {
  if (m.role === "assistant") {
    return (
      <div className="rounded-md border border-neutral-800/70 bg-neutral-900/40 px-2.5 py-2">
        <RoleLabel role="assistant" ts={m.createdAt} />
        <div className="mt-1 text-[12.5px] leading-snug text-neutral-200">
          <AssistantMarkdown content={m.content} />
        </div>
      </div>
    );
  }
  if (m.role === "user") {
    return (
      <div className="rounded-md border border-neutral-800/40 bg-neutral-900/20 px-2.5 py-2">
        <RoleLabel role="user" ts={m.createdAt} />
        <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-snug text-neutral-300">
          {m.content}
        </p>
      </div>
    );
  }
  return null;
}

function RoleLabel({ role, ts }: { role: "user" | "assistant"; ts: number }) {
  return (
    <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.2em] text-neutral-500">
      <span className={role === "assistant" ? "text-orange-400/80" : "text-neutral-400"}>
        {role}
      </span>
      <span className="text-neutral-700">·</span>
      <span>{absoluteTime(ts)}</span>
    </div>
  );
}

function LoadingHint() {
  return (
    <div className="amaso-fade-in flex-1 px-4 py-8 text-center text-xs text-neutral-500">
      Loading…
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="amaso-fade-in flex-1 px-4 py-8 text-center text-xs leading-relaxed text-neutral-500">
      {msg}
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  if (diff < 7 * 24 * 60 * 60_000) {
    return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
  }
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(dateLocal: string): string {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/Amsterdam",
  });
  if (dateLocal === today) return "Today";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = y.toLocaleDateString("en-CA", {
    timeZone: "Europe/Amsterdam",
  });
  if (dateLocal === yesterday) return "Yesterday";
  const [yyyy, mm, dd] = dateLocal.split("-").map(Number);
  if (!yyyy || !mm || !dd) return dateLocal;
  const d = new Date(yyyy, mm - 1, dd);
  // Within the last 7 days, weekday name; older, full short date.
  const ageDays = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60_000));
  if (ageDays >= 0 && ageDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: ageDays > 300 ? "numeric" : undefined,
  });
}

