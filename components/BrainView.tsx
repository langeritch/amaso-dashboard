"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brain, Phone, Sparkles } from "lucide-react";
import BrainGraph from "./BrainGraph";
import MemoryPanel from "./MemoryPanel";
import BrainSparringPanel from "./BrainSparringPanel";

type Tab = "graph" | "memory" | "spar";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "graph", label: "Graph", icon: Brain },
  { id: "memory", label: "Memory", icon: Sparkles },
  { id: "spar", label: "Sparring partner", icon: Phone },
];

interface ProjectLite {
  id: string;
  name: string;
}

interface OpenRemark {
  id: number;
  userName: string;
  projectId: string;
  path: string | null;
  line: number | null;
  category: "frontend" | "backend" | "other";
  body: string;
  createdAt: number;
}

export default function BrainView({
  projects,
  openRemarks,
}: {
  projects: ProjectLite[];
  openRemarks: OpenRemark[];
}) {
  const params = useSearchParams();
  const router = useRouter();

  const tabParam = params.get("tab");
  const tab: Tab =
    tabParam === "memory" || tabParam === "spar" ? tabParam : "graph";

  const setTab = useCallback(
    (next: Tab) => {
      const url = new URLSearchParams(params.toString());
      if (next === "graph") url.delete("tab");
      else url.set("tab", next);
      const qs = url.toString();
      router.replace(qs ? `/brain?${qs}` : "/brain", { scroll: false });
    },
    [params, router],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Brain views"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800 bg-neutral-950 px-2 sm:px-3"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setTab(id)}
              className={`flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm transition border-b-2 -mb-px ${
                active
                  ? "border-indigo-400 text-neutral-100"
                  : "border-transparent text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "graph" && <BrainGraph />}
        {tab === "memory" && (
          <div className="h-full overflow-y-auto">
            <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
              <header className="mb-5 sm:mb-6">
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  Memory
                </h1>
                <p className="mt-2 text-sm text-neutral-400">
                  What the assistant has learned about you across
                  conversations. Edit or remove anything that&rsquo;s wrong.
                </p>
              </header>
              <MemoryPanel />
            </main>
          </div>
        )}
        {tab === "spar" && (
          <div className="h-full overflow-y-auto">
            <BrainSparringPanel
              projects={projects}
              openRemarks={openRemarks}
            />
          </div>
        )}
      </div>
    </div>
  );
}
