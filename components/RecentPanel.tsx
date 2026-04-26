"use client";

import { useEffect, useState } from "react";

interface RecentEvent {
  id: number;
  type: "add" | "change" | "unlink";
  path: string;
  ts: number;
}

interface DiffResponse {
  event: RecentEvent;
  patch: string;
  hasPrevious: boolean;
  hasCurrent: boolean;
}

export default function RecentPanel({
  projectId,
  wsBump,
}: {
  projectId: string;
  /** Incremented by the parent whenever a history event arrives over WS. */
  wsBump: number;
}) {
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);

  async function refresh() {
    const res = await fetch(`/api/projects/${projectId}/recent?limit=50`, {
      cache: "no-store",
    });
    const body = await res.json();
    setEvents(body.events);
  }
  useEffect(() => {
    void refresh();
  }, [projectId, wsBump]);

  useEffect(() => {
    if (selectedId === null) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    fetch(`/api/projects/${projectId}/recent/${selectedId}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((d: DiffResponse) => {
        if (!cancelled) setDiff(d);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
        Recent changes
      </div>
      {events.length === 0 ? (
        <div className="px-4 py-6 text-sm text-neutral-500">
          No changes yet. Edit a file to see it here.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
          <ul className="thin-scroll overflow-auto border-r border-neutral-800">
            {events.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(e.id)}
                  className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-800/50 ${
                    selectedId === e.id ? "bg-neutral-800 text-white" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Badge type={e.type} />
                    <span className="truncate font-mono text-neutral-300">
                      {e.path}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-neutral-500">
                    {new Date(e.ts).toLocaleTimeString()}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="thin-scroll overflow-auto">
            {selectedId === null ? (
              <Info>Select an event to see the diff.</Info>
            ) : !diff ? (
              <Info>Loading diff…</Info>
            ) : !diff.hasPrevious && diff.event.type !== "add" ? (
              <Info>
                No prior snapshot for this file — diffs will appear starting
                from the next change.
              </Info>
            ) : (
              <DiffView patch={diff.patch} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Badge({ type }: { type: RecentEvent["type"] }) {
  const map = {
    add: "bg-emerald-900/40 text-emerald-300 border-emerald-800/60",
    change: "bg-amber-900/40 text-amber-300 border-amber-800/60",
    unlink: "bg-red-900/40 text-red-300 border-red-800/60",
  } as const;
  return (
    <span
      className={`inline-block rounded border px-1 py-px font-mono text-[9px] uppercase ${map[type]}`}
    >
      {type}
    </span>
  );
}

function Info({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-sm text-neutral-500">{children}</div>;
}

function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre className="p-3 font-mono text-[12px] leading-relaxed">
      {lines.map((line, i) => {
        let cls = "text-neutral-400";
        if (line.startsWith("+") && !line.startsWith("+++"))
          cls = "bg-emerald-900/20 text-emerald-300";
        else if (line.startsWith("-") && !line.startsWith("---"))
          cls = "bg-red-900/20 text-red-300";
        else if (line.startsWith("@@")) cls = "text-sky-400";
        else if (line.startsWith("Index:") || line.startsWith("==="))
          cls = "text-neutral-500";
        return (
          <div key={i} className={cls}>
            {line || "\u00A0"}
          </div>
        );
      })}
    </pre>
  );
}
