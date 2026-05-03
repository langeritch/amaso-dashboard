import { notFound } from "next/navigation";
import { requireClient } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { getProject } from "@/lib/config";
import { getHistory } from "@/lib/history";
import { getStatus as getTerminalStatus } from "@/lib/terminal-backend";
import ClientProjectView from "@/components/client/ClientProjectView";

export const dynamic = "force-dynamic";

export default async function ClientProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireClient();
  const { id } = await params;
  if (!canAccessProject(user, id)) notFound();
  const project = getProject(id);
  if (!project) notFound();

  const term = getTerminalStatus(id);
  const recent = getHistory().recent(id, 1);
  const lastActivityAt = Math.max(
    recent[0]?.ts ?? 0,
    term.running ? (term.startedAt ?? 0) : 0,
  );

  return (
    <ClientProjectView
      project={{
        id: project.id,
        name: project.name,
        previewUrl: project.previewUrl ?? null,
        liveUrl: project.liveUrl ?? null,
        deployBranch: project.deployBranch ?? null,
      }}
      working={term.running}
      lastActivityAt={lastActivityAt}
      currentUser={{ id: user.id, name: user.name }}
    />
  );
}
