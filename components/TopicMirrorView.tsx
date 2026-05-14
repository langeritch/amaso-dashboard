"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import AssistantMarkdown from "./AssistantMarkdown";
import type { ActiveTopic } from "./TopicPill";

/**
 * Read-only "mirror" of the main spar chat scoped to a single topic.
 *
 * Renders the same visual shell as SparFullView's text-mode chat
 * (same width cap, same bubble styling, same scrollback chrome) so
 * the user perceives it as "the same view, filtered to this topic"
 * rather than a separate inspector panel.
 *
 * The composer is NOT shown here — the only way out is Close (back to
 * the live main view, no pill) or "Ask about this" (back to the live
 * main view AND set the composer's topic pill so the next send is
 * topic-scoped). This matches the PWA TopicDetail flow in
 * components/mobile/history.tsx; the dashboard side intentionally
 * tracks it line-for-line so the two surfaces feel identical.
 *
 * Messages come from /api/spar/topics/[slug]/messages — same endpoint
 * the PWA hits, same shape, sorted ascending by createdAt.
 */

interface MirrorMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
}

interface MirrorData {
  topic: {
    id: number;
    slug: string;
    title: string;
    summary: string | null;
  };
  messages: MirrorMessage[];
}

interface Props {
  topic: ActiveTopic;
  onAskAbout: () => void;
  onClose: () => void;
  paddingTop: string;
  bottomReserve: string | number;
}

export default function TopicMirrorView({
  topic,
  onAskAbout,
  onClose,
  paddingTop,
  bottomReserve,
}: Props) {
  const [data, setData] = useState<MirrorData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/spar/topics/${encodeURIComponent(topic.slug)}/messages`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [topic.slug]);

  const title = data?.topic.title ?? topic.title;
  const summary = data?.topic.summary ?? null;

  return (
    <div
      className="absolute inset-x-0 top-0 flex min-h-0 flex-col"
      style={{ paddingTop, bottom: bottomReserve }}
      data-topic-mirror={topic.slug}
    >
      {/* Header strip — topic name, summary, primary Ask-about-this
          CTA, and a subtle close. Mirrors the PWA TopicDetail header
          plus the "Ask AI about this" footer button, collapsed into
          one row because desktop has the horizontal room for it. */}
      <div className="flex flex-shrink-0 items-start gap-3 border-b border-neutral-800/80 bg-neutral-950/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 flex-shrink-0 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.6)]"
            />
            <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
              Topic mirror
            </span>
          </div>
          <h2
            className="mt-1 truncate text-sm font-semibold tracking-tight text-neutral-100"
            title={title}
          >
            {title}
          </h2>
          {summary && (
            <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-neutral-400">
              {summary}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onAskAbout}
            className="amaso-fx amaso-press rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-[12px] font-medium text-orange-200 transition-colors hover:bg-orange-500/20 hover:text-orange-100"
            title="Return to the live chat with this topic loaded in the composer"
          >
            Ask about this
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close topic mirror"
            title="Close mirror (return to live chat)"
            className="amaso-fx amaso-press inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-800 text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
          {error ? (
            <li className="mt-8 text-center text-sm text-rose-300/80">
              Couldn&rsquo;t load this topic ({error}).
            </li>
          ) : data === null ? (
            <li className="mt-8 text-center text-[12px] text-neutral-500">
              Loading…
            </li>
          ) : data.messages.length === 0 ? (
            <li className="mt-8 text-center text-[12px] text-neutral-500">
              No messages tagged with this topic yet.
            </li>
          ) : (
            data.messages.map((m) =>
              m.role === "user" ? (
                <li
                  key={m.id}
                  className="amaso-fade-in max-w-[85%] self-end rounded-2xl rounded-tr-md bg-orange-600/25 px-4 py-2.5 text-[14px] leading-[1.55] tracking-[-0.005em] whitespace-pre-wrap text-orange-50 ring-1 ring-orange-400/15 shadow-[0_1px_2px_rgba(0,0,0,0.18)]"
                >
                  {m.content}
                </li>
              ) : (
                <li
                  key={m.id}
                  className="amaso-fade-in flex max-w-[85%] flex-col self-start"
                >
                  <div className="rounded-2xl rounded-tl-md bg-neutral-800/70 px-4 py-2.5 text-[14px] leading-[1.55] tracking-[-0.005em] text-neutral-100 ring-1 ring-white/[0.04] shadow-[0_1px_2px_rgba(0,0,0,0.18)]">
                    <AssistantMarkdown content={m.content} />
                  </div>
                </li>
              ),
            )
          )}
        </ul>
      </div>

      {/* Footer hint — replaces the composer so users know why they
          can't type. Mirror is intentionally read-only; the CTA above
          is the only way to start chatting about this topic. */}
      <div className="flex flex-shrink-0 items-center justify-center border-t border-neutral-900/80 bg-neutral-950/60 px-4 py-3 text-[11px] text-neutral-500">
        Read-only mirror —
        <button
          type="button"
          onClick={onAskAbout}
          className="ml-1 text-orange-300 underline-offset-2 hover:underline"
        >
          Ask about this
        </button>
        &nbsp;to start chatting on this topic.
      </div>
    </div>
  );
}
