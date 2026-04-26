"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import type { Automation, AutomationWithStats } from "@/lib/automations";

export default function AutomationsList({
  onLaunch,
}: {
  // Called when the user clicks Run on a card. Lets the parent decide
  // whether to navigate the current window (legacy /automations page),
  // open a new embedded-browser tab, or send a WS navigate message.
  onLaunch: (automation: Automation) => void;
}) {
  const [items, setItems] = useState<AutomationWithStats[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<AutomationWithStats | null>(null);
  const [adding, setAdding] = useState(false);

  // Self-fetch — the launcher now lives inside BrowserViewer (a client
  // component) where there's no server-fetched initial payload.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/automations", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { automations: AutomationWithStats[] };
        if (!cancelled) {
          setItems(data.automations);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function run(a: AutomationWithStats) {
    onLaunch(a);
  }

  async function handleDelete(a: AutomationWithStats) {
    if (!confirm(`Delete "${a.name}"?`)) return;
    const res = await fetch(`/api/automations/${a.id}`, { method: "DELETE" });
    if (!res.ok) return;
    setItems((prev) => prev.filter((x) => x.id !== a.id));
  }

  async function handleSave(form: SaveInput, existingId: number | null) {
    const url = existingId
      ? `/api/automations/${existingId}`
      : "/api/automations";
    const method = existingId ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        description: form.description,
        url: form.url,
      }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      return j?.error ?? "save_failed";
    }
    const data = (await res.json()) as { automation: AutomationWithStats };
    setItems((prev) => {
      if (existingId) {
        return prev.map((x) => (x.id === existingId ? data.automation : x));
      }
      return [...prev, data.automation];
    });
    return null;
  }

  return (
    <>
      {!loaded ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState onAdd={() => setAdding(true)} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {items.map((a) => (
            <li
              key={a.id}
              className="group flex items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 transition hover:border-neutral-700"
            >
              <button
                type="button"
                onClick={() => run(a)}
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 transition hover:border-emerald-400 hover:bg-emerald-500/20"
                aria-label={`Run ${a.name}`}
                title={`Run ${a.name}`}
              >
                <Play className="h-4 w-4 fill-current" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-medium text-neutral-100">
                    {a.name}
                  </h2>
                  {!a.enabled && (
                    <span className="rounded-full border border-neutral-700 px-1.5 py-0.5 text-[9px] uppercase text-neutral-500">
                      disabled
                    </span>
                  )}
                </div>
                {a.description && (
                  <p className="mt-0.5 truncate text-xs text-neutral-400">
                    {a.description}
                  </p>
                )}
                <p className="mt-1 truncate font-mono text-[11px] text-neutral-500">
                  {a.payload.url}
                </p>
                <StatsRow stats={a.stats} />
              </div>
              <div className="flex flex-shrink-0 flex-col gap-1 opacity-0 transition group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => setEditing(a)}
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                  aria-label={`Edit ${a.name}`}
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(a)}
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-red-400"
                  aria-label={`Delete ${a.name}`}
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-4 flex items-center gap-2 rounded-md border border-dashed border-neutral-700 px-3 py-2 text-sm text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
        >
          <Plus className="h-4 w-4" />
          Add automation
        </button>
      )}

      {(editing || adding) && (
        <AutomationForm
          existing={editing}
          onClose={() => {
            setEditing(null);
            setAdding(false);
          }}
          onSave={async (form) => {
            const err = await handleSave(form, editing?.id ?? null);
            if (!err) {
              setEditing(null);
              setAdding(false);
            }
            return err;
          }}
        />
      )}
    </>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-800 p-8 text-center">
      <h2 className="text-lg font-medium">No automations yet</h2>
      <p className="mt-2 text-sm text-neutral-400">
        Save the URLs you reach for every morning so you can launch them in one
        click.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
      >
        <Plus className="h-4 w-4" />
        Add your first
      </button>
    </div>
  );
}

interface SaveInput {
  name: string;
  description: string;
  url: string;
}

function AutomationForm({
  existing,
  onClose,
  onSave,
}: {
  existing: Automation | null;
  onClose: () => void;
  onSave: (form: SaveInput) => Promise<string | null>;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [url, setUrl] = useState(existing?.payload.url ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) {
      setError("name and url are required");
      return;
    }
    setSubmitting(true);
    setError(null);
    const err = await onSave({
      name: name.trim(),
      description: description.trim(),
      url: url.trim(),
    });
    setSubmitting(false);
    if (err) setError(err);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handle}
        className="w-full max-w-md rounded-t-lg border border-neutral-800 bg-neutral-950 p-4 shadow-xl sm:rounded-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-100">
            {existing ? "Edit automation" : "Add automation"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Outlook"
              autoFocus
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </Field>
          <Field label="URL">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://outlook.office.com"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </Field>
          <Field label="Description (optional)">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Inbox + calendar"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </Field>
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-400">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {submitting ? "Saving…" : existing ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatsRow({
  stats,
}: {
  stats: AutomationWithStats["stats"];
}) {
  if (stats.runCount === 0) {
    return (
      <p className="mt-2 text-[10px] uppercase tracking-wider text-neutral-600">
        Never run
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wider text-neutral-500">
      <span>Last {relativeTime(stats.lastRunAt)}</span>
      <span>{stats.runCount} {stats.runCount === 1 ? "run" : "runs"}</span>
      {stats.failedRuns > 0 && (
        <span className="inline-flex items-center gap-1 text-red-400">
          <AlertTriangle className="h-2.5 w-2.5" />
          {stats.failedRuns} failed
        </span>
      )}
      {stats.clarificationsNeeded > 0 && (
        <span className="text-amber-400">
          {stats.clarificationsNeeded} to clarify
        </span>
      )}
    </div>
  );
}

function relativeTime(ts: number | null): string {
  if (ts == null) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
