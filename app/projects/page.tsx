import Link from "next/link";
import { requireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { getHistory } from "@/lib/history";
import { getStatus as getTerminalStatus } from "@/lib/terminal";
import { formatRelativeTime } from "@/lib/relative-time";
import Topbar from "@/components/Topbar";
import NewProjectButton from "@/components/NewProjectButton";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const user = await requireUser();
  const rawProjects = visibleProjects(user);

  // Sort most-recent first. Combines several "user touched this lately"
  // signals — strongest wins:
  //   1. Most recent file-change event from the watcher.
  //   2. Active terminal session startedAt (covers freshly-started
  //      sessions before any file has changed yet).
  // Tiebreak by original config-array index so newly-added projects
  // (addProject() appends to amaso.config.json) float above older entries
  // when neither has activity — typical right after a server restart.
  const history = getHistory();
  const enriched = rawProjects.map((p, idx) => {
    const recent = history.recent(p.id, 1);
    const lastFileTs = recent[0]?.ts ?? 0;
    const term = getTerminalStatus(p.id);
    const lastTermTs = term.running ? term.startedAt ?? 0 : 0;
    const lastActivityAt = Math.max(lastFileTs, lastTermTs);
    return {
      project: p,
      lastActivityAt,
      configIndex: idx,
      terminalRunning: term.running,
    };
  });
  enriched.sort((a, b) => {
    if (b.lastActivityAt !== a.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt;
    }
    return a.configIndex - b.configIndex;
  });

  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-12">
        <header className="mb-6 flex items-start justify-between gap-3 sm:mb-10">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Projects
            </h1>
            <p className="mt-2 text-sm text-neutral-400">
              Live view of projects running on this machine.
            </p>
          </div>
          {user.role === "admin" && <NewProjectButton />}
        </header>

        {enriched.length === 0 ? (
          <EmptyState isAdmin={user.role === "admin"} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {enriched.map(({ project: p, lastActivityAt, terminalRunning }) => {
              const relative = formatRelativeTime(lastActivityAt);
              return (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="block rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 transition hover:border-neutral-700 hover:bg-neutral-900"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <h2 className="truncate font-medium">{p.name}</h2>
                        {terminalRunning && (
                          <span
                            className="relative flex h-2 w-2 flex-shrink-0"
                            aria-label="Terminal running"
                            title="Terminal running"
                          >
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                          </span>
                        )}
                      </div>
                      <span className="flex-shrink-0 rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
                        {p.visibility}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-neutral-500">id: {p.id}</p>
                    <p className="mt-2 text-xs text-neutral-400">
                      {relative ? `Last active ${relative}` : "No recent activity"}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

function EmptyState({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-800 p-8 text-center">
      <h2 className="text-lg font-medium">No projects visible</h2>
      <p className="mt-2 text-sm text-neutral-400">
        {isAdmin ? (
          <>
            Add entries to{" "}
            <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs">
              amaso.config.json
            </code>{" "}
            and restart the server.
          </>
        ) : (
          <>No projects have been assigned to your account yet.</>
        )}
      </p>
    </div>
  );
}
