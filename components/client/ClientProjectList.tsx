"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalLink, Inbox } from "lucide-react";
import { formatRelativeTime } from "@/lib/relative-time";

interface ProjectCard {
  id: string;
  name: string;
  visibility: "team" | "client" | "public";
  previewUrl: string | null;
  liveUrl: string | null;
  lastActivityAt: number;
  working: boolean;
}

export default function ClientProjectList({
  projects,
}: {
  projects: ProjectCard[];
}) {
  if (projects.length === 0) {
    return (
      <div className="amaso-fade-in-slow flex flex-col items-center rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/30 px-6 py-14 text-center">
        <span
          aria-hidden
          className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-orange-500/30 bg-orange-500/5"
        >
          <Inbox className="h-6 w-6 text-orange-400" />
        </span>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100">
          No projects yet
        </h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-neutral-400">
          Your account is set up, but no projects have been shared with you
          yet. We&rsquo;ll let you know as soon as one is ready.
        </p>
      </div>
    );
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {projects.map((p, idx) => (
        <ProjectListItem key={p.id} project={p} index={idx} />
      ))}
    </ul>
  );
}

function ProjectListItem({
  project: p,
  index,
}: {
  project: ProjectCard;
  index: number;
}) {
  // Re-render the relative timestamp every minute so "Last updated 3 min
  // ago" doesn't go stale while the user is sitting on the dashboard.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  void tick;

  const relative = formatRelativeTime(p.lastActivityAt);
  return (
    <li
      className="amaso-fade-in"
      style={{ animationDelay: `${Math.min(index, 8) * 50}ms` }}
    >
      <Link
        href={`/client/projects/${p.id}`}
        className="amaso-surface-hover amaso-press group block overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/50 hover:border-orange-500/40 hover:bg-neutral-900/80"
      >
        {/* Mini preview pane — iframe peek of the live or preview URL.
            Pointer-events disabled so the whole card is the click
            target; the preview is decorative until the user opens the
            project detail page. */}
        <div className="relative aspect-[16/9] overflow-hidden border-b border-neutral-800/70 bg-neutral-950">
          {p.liveUrl || p.previewUrl ? (
            <iframe
              src={(p.liveUrl ?? p.previewUrl)!}
              title={`${p.name} preview`}
              className="pointer-events-none h-full w-full origin-top-left scale-[0.5] transition-transform duration-300"
              style={{ width: "200%", height: "200%" }}
              loading="lazy"
              sandbox="allow-same-origin"
              aria-hidden
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-neutral-600">
              No preview yet
            </div>
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-neutral-950/70 via-transparent to-transparent" />
          {p.working && (
            <span className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-neutral-950/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-orange-300 backdrop-blur">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400/70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
              </span>
              Working
            </span>
          )}
        </div>

        <div className="p-4 sm:p-5">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-base font-semibold tracking-tight text-neutral-100 transition-colors duration-200 group-hover:text-white">
              {p.name}
            </h2>
            {p.liveUrl && (
              <span
                className="amaso-fx inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-200"
                title={p.liveUrl}
              >
                <ExternalLink className="h-3 w-3" />
                Live
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-neutral-400">
            {relative ? `Last updated ${relative}` : "Awaiting first update"}
          </p>
        </div>
      </Link>
    </li>
  );
}
