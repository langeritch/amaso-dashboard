"use client";

import { useCallback, useEffect, useState } from "react";
import { Send, MessageCircle, Check } from "lucide-react";
import { formatRelativeTime } from "@/lib/relative-time";

interface RemarkView {
  id: number;
  userId: number;
  userName: string;
  body: string;
  category: "frontend" | "backend" | "other";
  createdAt: number;
  resolvedAt: number | null;
}

export default function ClientRemarks({
  projectId,
  currentUser,
}: {
  projectId: string;
  currentUser: { id: number; name: string };
}) {
  const [remarks, setRemarks] = useState<RemarkView[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/remarks?scope=project`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        setError("Couldn’t load feedback. Try again in a moment.");
        return;
      }
      const data = (await res.json()) as { remarks: RemarkView[] };
      setRemarks(data.remarks ?? []);
      setError(null);
    } catch {
      setError("Couldn’t load feedback. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const body = draft.trim();
      if (!body || sending) return;
      setSending(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/remarks`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body, category: "other" }),
          },
        );
        if (!res.ok) {
          setError("Couldn’t send. Please try again.");
          return;
        }
        setDraft("");
        await refresh();
      } catch {
        setError("Couldn’t send. Please try again.");
      } finally {
        setSending(false);
      }
    },
    [draft, projectId, refresh, sending],
  );

  return (
    <aside className="flex flex-col overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/40 shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
      <header className="flex items-center gap-2 border-b border-neutral-800/70 px-4 py-3">
        <MessageCircle className="h-4 w-4 text-neutral-400" />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-400">
          Feedback
        </h2>
        <span className="ml-auto text-[11px] text-neutral-500">
          {remarks.length} total
        </span>
      </header>

      <div className="thin-scroll max-h-[480px] flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            <div className="amaso-skeleton h-12" />
            <div className="amaso-skeleton h-12" />
            <div className="amaso-skeleton h-10" />
          </div>
        ) : remarks.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-neutral-500">
            <p>No feedback yet.</p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-600">
              Spotted something off? Want a tweak? Leave a note below — your
              team sees it instantly.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800/60">
            {remarks.map((r) => (
              <RemarkRow
                key={r.id}
                remark={r}
                isMine={r.userId === currentUser.id}
              />
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={submit}
        className="border-t border-neutral-800/70 bg-neutral-950/40 p-3"
      >
        <div className="flex items-end gap-2 rounded-xl border border-neutral-800 bg-neutral-900/70 px-3 py-2 transition-[border-color,box-shadow] duration-200 ease-out focus-within:border-orange-500/50 focus-within:shadow-[0_0_0_3px_rgba(255,107,61,0.12)]">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit(e as unknown as React.FormEvent);
              }
            }}
            placeholder="Leave a note for the team…"
            rows={2}
            className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-relaxed text-neutral-100 placeholder-neutral-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            className="amaso-fx amaso-press flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-orange-500 text-neutral-950 shadow-[0_2px_8px_rgba(255,107,61,0.35)] hover:bg-orange-400 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:shadow-none"
            aria-label="Send feedback"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        {error && (
          <p className="mt-2 text-xs text-rose-300">{error}</p>
        )}
        <p className="mt-2 text-[10px] text-neutral-600">
          ⌘/Ctrl + Enter to send
        </p>
      </form>
    </aside>
  );
}

function RemarkRow({
  remark,
  isMine,
}: {
  remark: RemarkView;
  isMine: boolean;
}) {
  const relative = formatRelativeTime(remark.createdAt);
  const resolved = remark.resolvedAt !== null;
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-neutral-200">
          {isMine ? "You" : remark.userName}
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-neutral-500">
          {resolved && (
            <span className="inline-flex items-center gap-1 rounded-full bg-lime-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-lime-300">
              <Check className="h-2.5 w-2.5" />
              Done
            </span>
          )}
          {relative ?? ""}
        </span>
      </div>
      <p
        className={`mt-1 whitespace-pre-wrap text-sm leading-relaxed ${
          resolved ? "text-neutral-500 line-through" : "text-neutral-200"
        }`}
      >
        {remark.body}
      </p>
    </li>
  );
}
