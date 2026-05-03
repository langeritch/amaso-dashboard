import { requireClient } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { getHistory } from "@/lib/history";
import { getStatus as getTerminalStatus } from "@/lib/terminal-backend";
import ClientProjectList from "@/components/client/ClientProjectList";

export const dynamic = "force-dynamic";

export default async function ClientHomePage() {
  const user = await requireClient();
  const projects = visibleProjects(user);
  const history = getHistory();

  const enriched = projects.map((p) => {
    const recent = history.recent(p.id, 1);
    const lastFileTs = recent[0]?.ts ?? 0;
    const term = getTerminalStatus(p.id);
    const lastTermTs = term.running ? (term.startedAt ?? 0) : 0;
    return {
      id: p.id,
      name: p.name,
      visibility: p.visibility,
      previewUrl: p.previewUrl ?? null,
      liveUrl: p.liveUrl ?? null,
      lastActivityAt: Math.max(lastFileTs, lastTermTs),
      working: term.running,
    };
  });
  enriched.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-8 sm:mb-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Welcome back, {user.name.split(" ")[0]}.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          Here are your projects. Tap one to see the live preview, leave
          feedback, or check what we&rsquo;re working on right now.
        </p>
      </header>
      <ClientProjectList projects={enriched} />
    </section>
  );
}
