"use client";

import { useEffect, useState } from "react";
import { ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { formatRelativeTime } from "@/lib/relative-time";
import ClientRemarks from "./ClientRemarks";

interface ProjectInfo {
  id: string;
  name: string;
  previewUrl: string | null;
  liveUrl: string | null;
  deployBranch: string | null;
}

export default function ClientProjectView({
  project,
  working,
  lastActivityAt,
  currentUser,
}: {
  project: ProjectInfo;
  working: boolean;
  lastActivityAt: number;
  currentUser: { id: number; name: string };
}) {
  const previewSrc = project.liveUrl ?? project.previewUrl;
  const [iframeKey, setIframeKey] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  void tick;
  const relative = formatRelativeTime(lastActivityAt);

  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">
            {project.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
            <StatusPill working={working} />
            {relative && (
              <span>Last activity {relative}</span>
            )}
            {project.deployBranch && (
              <span className="inline-flex items-center gap-1 font-mono text-[11px] text-neutral-500">
                <GitBranch className="h-3 w-3" />
                {project.deployBranch}
              </span>
            )}
          </div>
        </div>
        {project.liveUrl && (
          <a
            href={project.liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="amaso-fx amaso-press inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-xs font-medium text-orange-200 hover:border-orange-400/60 hover:bg-orange-500/20"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open live site
          </a>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Live preview */}
        <div className="overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/40 shadow-[0_4px_24px_rgba(0,0,0,0.35)]">
          <div className="flex items-center justify-between gap-2 border-b border-neutral-800/70 px-3 py-2">
            <span className="truncate font-mono text-[11px] text-neutral-500">
              {previewSrc ?? "No preview URL configured"}
            </span>
            {previewSrc && (
              <button
                type="button"
                onClick={() => setIframeKey((k) => k + 1)}
                className="amaso-fx amaso-press flex h-9 w-9 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100 sm:h-7 sm:w-7"
                title="Refresh preview"
                aria-label="Refresh preview"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="relative aspect-[16/10] bg-neutral-950">
            {previewSrc ? (
              <iframe
                key={iframeKey}
                src={previewSrc}
                title={`${project.name} preview`}
                className="absolute inset-0 h-full w-full"
                loading="lazy"
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                A preview will appear here once the site is deployed.
              </div>
            )}
          </div>
        </div>

        {/* Remarks / feedback */}
        <ClientRemarks projectId={project.id} currentUser={currentUser} />
      </div>
    </section>
  );
}

function StatusPill({ working }: { working: boolean }) {
  if (working) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-300">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400/70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
        </span>
        Working now
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700/80 bg-neutral-900/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
      <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
      Idle
    </span>
  );
}
