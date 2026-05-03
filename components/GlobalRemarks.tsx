"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ExternalLink, StickyNote } from "lucide-react";

type Category = "frontend" | "backend" | "other";

interface GlobalRemark {
  id: number;
  userId: number;
  userName: string;
  projectId: string;
  path: string | null;
  line: number | null;
  category: Category;
  body: string;
  createdAt: number;
  resolvedAt: number | null;
}

interface ProjectLite {
  id: string;
  name: string;
}

export default function GlobalRemarks({
  projects,
  remarks,
}: {
  projects: ProjectLite[];
  remarks: GlobalRemark[];
}) {
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | Category>("all");
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");

  const projectName = useMemo(() => {
    const m = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? id;
  }, [projects]);

  const filtered = useMemo(() => {
    return remarks.filter((r) => {
      if (projectFilter !== "all" && r.projectId !== projectFilter) return false;
      if (categoryFilter !== "all" && r.category !== categoryFilter) return false;
      if (status === "open" && r.resolvedAt) return false;
      if (status === "resolved" && !r.resolvedAt) return false;
      return true;
    });
  }, [remarks, projectFilter, categoryFilter, status]);

  const counts = useMemo(() => {
    let open = 0;
    let resolved = 0;
    for (const r of remarks) {
      if (r.resolvedAt) resolved += 1;
      else open += 1;
    }
    return { open, resolved, total: remarks.length };
  }, [remarks]);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        <Chip
          active={status === "open"}
          onClick={() => setStatus("open")}
        >
          Open · {counts.open}
        </Chip>
        <Chip
          active={status === "resolved"}
          onClick={() => setStatus("resolved")}
        >
          Resolved · {counts.resolved}
        </Chip>
        <Chip active={status === "all"} onClick={() => setStatus("all")}>
          All · {counts.total}
        </Chip>
        <span className="mx-1 hidden text-neutral-700 sm:inline">|</span>
        <div className="flex w-full gap-2 sm:w-auto sm:contents">
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="min-h-[40px] flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 sm:min-h-0 sm:flex-none"
          >
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as "all" | Category)}
            className="min-h-[40px] flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 sm:min-h-0 sm:flex-none"
          >
            <option value="all">All categories</option>
            <option value="frontend">Frontend</option>
            <option value="backend">Backend</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 p-10 text-center text-sm text-neutral-500">
          No remarks match these filters.
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            <li
              key={r.id}
              className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
                <StickyNote className="h-3 w-3 text-amber-400" />
                <CategoryBadge category={r.category} />
                <Link
                  href={`/projects/${r.projectId}`}
                  className="rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-700"
                >
                  {projectName(r.projectId)}
                </Link>
                {r.path && (
                  <span
                    className="truncate rounded bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10px]"
                    title={r.path}
                  >
                    {r.path.split("/").slice(-2).join("/")}
                    {r.line !== null && `:${r.line}`}
                  </span>
                )}
                <span className="text-neutral-500">·</span>
                <span className="text-neutral-300">{r.userName}</span>
                <span className="text-neutral-500">·</span>
                <span>{relTime(r.createdAt)}</span>
                {r.resolvedAt && (
                  <span className="ml-auto rounded-full border border-orange-700 bg-orange-900/30 px-1.5 py-0.5 text-[10px] text-orange-200">
                    resolved
                  </span>
                )}
                <Link
                  href={`/projects/${r.projectId}`}
                  className="ml-1 text-neutral-500 hover:text-orange-400"
                  title="Open project"
                >
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-neutral-100">
                {r.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 transition ${
        active
          ? "border-neutral-500 bg-neutral-800 text-white"
          : "border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}

function CategoryBadge({ category }: { category: Category }) {
  const styles = {
    frontend: "border-sky-800/60 bg-sky-900/30 text-sky-300",
    backend: "border-violet-800/60 bg-violet-900/30 text-violet-300",
    other: "border-neutral-700 bg-neutral-800/70 text-neutral-300",
  } as const;
  return (
    <span
      className={`rounded border px-1 py-0.5 font-mono text-[9px] uppercase ${styles[category]}`}
    >
      {category}
    </span>
  );
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}
