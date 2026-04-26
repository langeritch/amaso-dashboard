import { requireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { getDb } from "@/lib/db";
import Topbar from "@/components/Topbar";
import BrainView from "@/components/BrainView";

export const dynamic = "force-dynamic";

interface OpenRemarkRow {
  id: number;
  user_id: number;
  project_id: string;
  path: string | null;
  line: number | null;
  category: "frontend" | "backend" | "other";
  body: string;
  created_at: number;
  user_name: string;
}

export default async function BrainPage() {
  const user = await requireUser();
  const projects = visibleProjects(user);
  const projectIds = projects.map((p) => p.id);

  let openRemarks: OpenRemarkRow[] = [];
  if (projectIds.length > 0) {
    const placeholders = projectIds.map(() => "?").join(",");
    openRemarks = getDb()
      .prepare(
        `SELECT r.id, r.user_id, r.project_id, r.path, r.line, r.category, r.body,
                r.created_at, u.name AS user_name
           FROM remarks r JOIN users u ON u.id = r.user_id
          WHERE r.project_id IN (${placeholders})
            AND r.resolved_at IS NULL
          ORDER BY r.created_at DESC`,
      )
      .all(...projectIds) as OpenRemarkRow[];
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <div className="min-h-0 flex-1">
        <BrainView
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          openRemarks={openRemarks.map((r) => ({
            id: r.id,
            userName: r.user_name,
            projectId: r.project_id,
            path: r.path,
            line: r.line,
            category: r.category,
            body: r.body,
            createdAt: r.created_at,
          }))}
        />
      </div>
    </div>
  );
}
