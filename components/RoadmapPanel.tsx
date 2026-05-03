"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X, Check } from "lucide-react";

/**
 * Per-project roadmap / flowchart view.
 *
 * Vertical timeline of step rows, each with a checkbox and an
 * optional ribbon of sub-steps indented underneath. New top-level
 * steps are added via the inline composer at the bottom; sub-steps
 * via the per-step "+ sub-step" affordance. Deletes cascade
 * server-side.
 *
 * Render strategy: build a parent → children index from the flat
 * server list, render two levels deep. Anything beyond depth 2 is
 * silently treated as a sub-step (the schema permits it; the UI
 * doesn't surface a way to create it).
 */

interface RoadmapStep {
  id: number;
  projectId: string;
  parentId: number | null;
  position: number;
  title: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

interface RoadmapPanelProps {
  projectId: string;
}

type ApiList = { steps: RoadmapStep[] };
type ApiSingle = { step: RoadmapStep };

export default function RoadmapPanel({ projectId }: RoadmapPanelProps) {
  const [steps, setSteps] = useState<RoadmapStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTopTitle, setNewTopTitle] = useState("");
  const [creating, setCreating] = useState(false);
  // parentId of the row whose "+ sub-step" composer is currently open.
  const [composerOpenFor, setComposerOpenFor] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/roadmap`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setError("Could not load roadmap");
        return;
      }
      const body = (await res.json()) as ApiList;
      setSteps(body.steps);
      setError(null);
    } catch {
      setError("Network error loading roadmap");
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { topLevel, childrenByParent, totalCount, doneCount } = useMemo(() => {
    const list = steps ?? [];
    const top: RoadmapStep[] = [];
    const byParent = new Map<number, RoadmapStep[]>();
    let total = 0;
    let done = 0;
    for (const s of list) {
      total += 1;
      if (s.done) done += 1;
      if (s.parentId === null) {
        top.push(s);
      } else {
        const arr = byParent.get(s.parentId);
        if (arr) arr.push(s);
        else byParent.set(s.parentId, [s]);
      }
    }
    return {
      topLevel: top,
      childrenByParent: byParent,
      totalCount: total,
      doneCount: done,
    };
  }, [steps]);

  const toggleDone = useCallback(
    async (step: RoadmapStep) => {
      // Optimistic flip — a failed PATCH falls back to a refresh which
      // will resync to server truth.
      setSteps((prev) =>
        prev
          ? prev.map((s) =>
              s.id === step.id ? { ...s, done: !s.done } : s,
            )
          : prev,
      );
      try {
        const res = await fetch(
          `/api/projects/${projectId}/roadmap/${step.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ done: !step.done }),
          },
        );
        if (!res.ok) await refresh();
      } catch {
        await refresh();
      }
    },
    [projectId, refresh],
  );

  const addStep = useCallback(
    async (title: string, parentId: number | null) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      setCreating(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/roadmap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed, parentId }),
        });
        if (!res.ok) {
          setError("Could not create step");
          return;
        }
        const body = (await res.json()) as ApiSingle;
        setSteps((prev) => (prev ? [...prev, body.step] : [body.step]));
      } catch {
        setError("Network error creating step");
      } finally {
        setCreating(false);
      }
    },
    [projectId],
  );

  const deleteStep = useCallback(
    async (step: RoadmapStep) => {
      // Optimistic remove of the step + its descendants. Server cascades
      // children but the local list still has them, so we strip here too.
      setSteps((prev) => {
        if (!prev) return prev;
        const childIds = new Set<number>();
        const collect = (pid: number) => {
          for (const s of prev) {
            if (s.parentId === pid) {
              childIds.add(s.id);
              collect(s.id);
            }
          }
        };
        collect(step.id);
        return prev.filter((s) => s.id !== step.id && !childIds.has(s.id));
      });
      try {
        await fetch(`/api/projects/${projectId}/roadmap/${step.id}`, {
          method: "DELETE",
        });
      } catch {
        await refresh();
      }
    },
    [projectId, refresh],
  );

  const renameStep = useCallback(
    async (step: RoadmapStep, title: string) => {
      const trimmed = title.trim();
      if (!trimmed || trimmed === step.title) return;
      setSteps((prev) =>
        prev
          ? prev.map((s) =>
              s.id === step.id ? { ...s, title: trimmed } : s,
            )
          : prev,
      );
      try {
        await fetch(`/api/projects/${projectId}/roadmap/${step.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        });
      } catch {
        await refresh();
      }
    },
    [projectId, refresh],
  );

  const progressPct =
    totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <div className="thin-scroll mx-auto h-full w-full max-w-3xl overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 sm:mb-8">
        <h2 className="text-lg font-semibold text-neutral-100 sm:text-xl">
          Roadmap
        </h2>
        <p className="mt-1 text-xs text-neutral-500 sm:text-sm">
          Steps and sub-steps for this project. Tick them off as work
          completes.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full bg-orange-500 transition-[width] duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="flex-shrink-0 font-mono text-xs tabular-nums text-neutral-400">
            {doneCount}/{totalCount} done
          </span>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-red-900/50 bg-red-900/20 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {steps === null ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : topLevel.length === 0 ? (
        <div className="amaso-fade-in-slow rounded-xl border border-dashed border-neutral-800 bg-neutral-900/30 px-6 py-10 text-center">
          <p className="text-sm font-medium text-neutral-300">
            No steps yet
          </p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-neutral-500">
            Add the first one below to start the roadmap.
          </p>
        </div>
      ) : (
        <ol className="relative space-y-3 border-l border-neutral-800 pl-5">
          {topLevel.map((step, idx) => (
            <StepRow
              key={step.id}
              step={step}
              index={idx}
              isLast={idx === topLevel.length - 1}
              children={childrenByParent.get(step.id) ?? []}
              composerOpen={composerOpenFor === step.id}
              onOpenComposer={() => setComposerOpenFor(step.id)}
              onCloseComposer={() => setComposerOpenFor(null)}
              onToggle={toggleDone}
              onDelete={deleteStep}
              onRename={renameStep}
              onAddChild={(title) => {
                void addStep(title, step.id).then(() =>
                  setComposerOpenFor(null),
                );
              }}
            />
          ))}
        </ol>
      )}

      <form
        className="mt-6 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newTopTitle.trim() || creating) return;
          void addStep(newTopTitle, null).then(() => setNewTopTitle(""));
        }}
      >
        <input
          type="text"
          value={newTopTitle}
          onChange={(e) => setNewTopTitle(e.target.value)}
          placeholder="Add a step…"
          maxLength={500}
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-orange-700 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!newTopTitle.trim() || creating}
          className="inline-flex items-center gap-1.5 rounded-md bg-orange-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          <Plus className="h-4 w-4" />
          Add
        </button>
      </form>
    </div>
  );
}

interface StepRowProps {
  step: RoadmapStep;
  index: number;
  isLast: boolean;
  children: RoadmapStep[];
  composerOpen: boolean;
  onOpenComposer: () => void;
  onCloseComposer: () => void;
  onToggle: (step: RoadmapStep) => void;
  onDelete: (step: RoadmapStep) => void;
  onRename: (step: RoadmapStep, title: string) => void;
  onAddChild: (title: string) => void;
}

function StepRow({
  step,
  index,
  children,
  composerOpen,
  onOpenComposer,
  onCloseComposer,
  onToggle,
  onDelete,
  onRename,
  onAddChild,
}: StepRowProps) {
  const childrenDone = children.filter((c) => c.done).length;
  // A step is "complete" if its own checkbox is ticked. Children
  // progress is shown as a small caption next to the title without
  // overriding the parent state — that lets the user explicitly
  // mark a step done before all sub-steps are, which matches how
  // people tend to track real work.
  return (
    <li className="relative">
      {/* Timeline dot — overlaps the parent <ol>'s left border. */}
      <span
        className={`absolute -left-[27px] top-2 flex h-4 w-4 items-center justify-center rounded-full border ${
          step.done
            ? "border-orange-500 bg-orange-500"
            : "border-neutral-700 bg-neutral-950"
        }`}
        aria-hidden="true"
      >
        {step.done ? (
          <Check className="h-2.5 w-2.5 text-neutral-950" strokeWidth={3} />
        ) : (
          <span className="text-[9px] font-mono text-neutral-500">
            {index + 1}
          </span>
        )}
      </span>

      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 transition hover:border-neutral-700">
        <StepHeader
          step={step}
          onToggle={onToggle}
          onDelete={(s) => {
            // Top-level steps with children would cascade — confirm first.
            if (
              children.length === 0 ||
              confirm(
                `Delete "${s.title}"? Any sub-steps will be removed too.`,
              )
            ) {
              onDelete(s);
            }
          }}
          onRename={onRename}
        />

        {(children.length > 0 || composerOpen) && (
          <ul className="mt-3 space-y-2 border-l border-neutral-800 pl-4">
            {children.map((c) => (
              <li key={c.id}>
                <StepHeader
                  step={c}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onRename={onRename}
                  compact
                />
              </li>
            ))}
            {composerOpen && (
              <li>
                <SubStepComposer
                  onCancel={onCloseComposer}
                  onSubmit={(title) => onAddChild(title)}
                />
              </li>
            )}
          </ul>
        )}

        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-neutral-500">
            {children.length > 0
              ? `${childrenDone}/${children.length} sub-steps`
              : ""}
          </span>
          {!composerOpen && (
            <button
              type="button"
              onClick={onOpenComposer}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
            >
              <Plus className="h-3 w-3" />
              sub-step
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function StepHeader({
  step,
  onToggle,
  onDelete,
  onRename,
  compact = false,
}: {
  step: RoadmapStep;
  onToggle: (s: RoadmapStep) => void;
  onDelete: (s: RoadmapStep) => void;
  onRename: (s: RoadmapStep, title: string) => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(step.title);

  return (
    <div className="flex items-start gap-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={step.done}
        onClick={() => onToggle(step)}
        className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition ${
          step.done
            ? "border-orange-500 bg-orange-500"
            : "border-neutral-600 bg-neutral-950 hover:border-neutral-400"
        }`}
        aria-label={step.done ? "Mark as not done" : "Mark as done"}
      >
        {step.done && (
          <Check className="h-3 w-3 text-neutral-950" strokeWidth={3} />
        )}
      </button>

      {editing ? (
        <form
          className="flex flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(step, draft);
            setEditing(false);
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onRename(step, draft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(step.title);
                setEditing(false);
              }
            }}
            maxLength={500}
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-sm text-neutral-100 focus:border-orange-700 focus:outline-none"
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(step.title);
            setEditing(true);
          }}
          className={`min-w-0 flex-1 break-words text-left transition hover:text-neutral-100 ${
            compact ? "text-sm" : "text-sm sm:text-[15px]"
          } ${
            step.done
              ? "text-neutral-500 line-through"
              : "text-neutral-200"
          }`}
        >
          {step.title}
        </button>
      )}

      <button
        type="button"
        onClick={() => onDelete(step)}
        className="flex-shrink-0 rounded p-1 text-neutral-600 transition hover:bg-neutral-800 hover:text-red-400"
        aria-label="Delete step"
        title="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SubStepComposer({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onSubmit(value);
        setValue("");
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Sub-step…"
        maxLength={500}
        className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-orange-700 focus:outline-none"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="rounded bg-orange-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded p-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
        aria-label="Cancel"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}
