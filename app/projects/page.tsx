import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { requireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { getHistory } from "@/lib/history";
import { getStatus as getTerminalStatus } from "@/lib/terminal-backend";
import { formatRelativeTime } from "@/lib/relative-time";
import { isSuperUser } from "@/lib/heartbeat";
import Topbar from "@/components/Topbar";
import NewProjectButton from "@/components/NewProjectButton";
import ProjectsLiveRefresh from "@/components/ProjectsLiveRefresh";
import PeopleActivity from "@/components/PeopleActivity";

type Visibility = "team" | "client" | "public";

function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  // Same colour system the role pills use in /admin/users so a card
  // tagged "client" reads at a glance as belonging to a client and
  // "team" reads as internal. Public sits on neutral.
  if (visibility === "team") {
    return (
      <span className="inline-flex items-center rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-200">
        team
      </span>
    );
  }
  if (visibility === "client") {
    return (
      <span className="inline-flex items-center rounded-full border border-lime-400/40 bg-lime-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-lime-200">
        client
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-neutral-700/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
      public
    </span>
  );
}

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
  const showPeopleActivity = isSuperUser(user);
  const peopleProjectsList = rawProjects.map((p) => ({ id: p.id, name: p.name }));
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
      <ProjectsLiveRefresh />
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

        {showPeopleActivity && (
          <section className="mb-8">
            <header className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-400">
                Team activity
              </h2>
              <Link
                href="/activity"
                className="amaso-fx text-xs text-neutral-500 underline-offset-2 hover:text-neutral-200 hover:underline"
              >
                Full feed →
              </Link>
            </header>
            <PeopleActivity projects={peopleProjectsList} />
          </section>
        )}

        {enriched.length === 0 ? (
          <EmptyState isAdmin={user.role === "admin"} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {enriched.map(({ project: p, lastActivityAt, terminalRunning }, idx) => {
              const relative = formatRelativeTime(lastActivityAt);
              return (
                <li
                  key={p.id}
                  className="amaso-fade-in"
                  // Staggered cascade — each card lands ~40ms after the
                  // previous so the grid reveals in a wave instead of
                  // all at once. Capped at 8 to avoid awkward delays
                  // for users with very long project lists.
                  style={{
                    animationDelay: `${Math.min(idx, 8) * 40}ms`,
                  }}
                >
                  <Link
                    href={`/projects/${p.id}`}
                    className="amaso-surface-hover amaso-press group block rounded-xl border border-neutral-800/80 bg-neutral-900/50 p-4 hover:border-orange-500/40 hover:bg-neutral-900/80"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <h2 className="truncate font-semibold tracking-tight text-neutral-100 transition-colors duration-200 group-hover:text-white">
                          {p.name}
                        </h2>
                      </div>
                      <VisibilityBadge visibility={p.visibility} />
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-neutral-500">
                      {p.id}
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <p className="text-xs text-neutral-400">
                        {relative
                          ? `Last active ${relative}`
                          : "No recent activity"}
                      </p>
                      {terminalRunning ? (
                        <span
                          className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-300"
                          aria-label="Terminal running"
                          title="Terminal running"
                        >
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400/70" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
                          </span>
                          Working
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-800/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
                          <span className="h-1.5 w-1.5 rounded-full bg-neutral-700" />
                          Idle
                        </span>
                      )}
                    </div>
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
    <div className="amaso-fade-in-slow flex flex-col items-center rounded-xl border border-dashed border-neutral-800 bg-neutral-900/30 px-6 py-12 text-center">
      <span
        aria-hidden
        className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-orange-500/30 bg-orange-500/5"
      >
        <FolderKanban className="h-5 w-5 text-orange-400" />
      </span>
      <h2 className="text-lg font-semibold tracking-tight text-neutral-100">
        No projects visible
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-neutral-400">
        {isAdmin ? (
          <>
            Add entries to{" "}
            <code className="rounded-md border border-neutral-800/80 bg-neutral-900/60 px-1.5 py-0.5 font-mono text-xs text-neutral-300">
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
