import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/lib/config";
import { requireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import Topbar from "@/components/Topbar";
import ProjectView from "@/components/ProjectView";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const project = getProject(id);
  if (!project || !canAccessProject(user, id)) notFound();

  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      {/* Compact on mobile — a 30px row (vs. the 40px tap-target we use
       * on desktop) is enough for a back arrow + truncated title. The
       * terminal needs every pixel it can claim, and this header is
       * glanceable rather than tappable-all-day. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-0.5 sm:gap-3 sm:px-4 sm:py-3">
        <Link
          href="/projects"
          className="flex min-h-[30px] min-w-[30px] flex-shrink-0 items-center justify-center whitespace-nowrap rounded-md text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 sm:min-h-0 sm:min-w-0 sm:px-2 sm:py-1"
          title="Back to projects"
          aria-label="Back to projects"
        >
          <span>←</span>
          <span className="ml-1 hidden sm:inline">Projects</span>
        </Link>
        <span className="hidden text-neutral-600 sm:inline">/</span>
        <h1
          className="min-w-0 flex-1 truncate text-xs font-medium sm:text-base"
          title={project.name}
        >
          {project.name}
        </h1>
        <span className="flex-shrink-0 rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400 sm:text-xs">
          {project.visibility}
        </span>
      </header>
      <ProjectView
        projectId={project.id}
        previewUrl={project.previewUrl}
        liveUrl={project.liveUrl}
        user={{ id: user.id, name: user.name, role: user.role }}
      />
    </div>
  );
}
