import { requireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { getDb } from "@/lib/db";
import Topbar from "@/components/Topbar";
import GlobalRemarks from "@/components/GlobalRemarks";

export const dynamic = "force-dynamic";

interface RemarkRow {
  id: number;
  user_id: number;
  project_id: string;
  path: string | null;
  line: number | null;
  category: "frontend" | "backend" | "other";
  body: string;
  created_at: number;
  resolved_at: number | null;
  user_name: string;
}

export default async function RemarksPage() {
  const user = await requireUser();
  const projects = visibleProjects(user);
  const projectIds = projects.map((p) => p.id);

  let remarks: RemarkRow[] = [];
  if (projectIds.length > 0) {
    const placeholders = projectIds.map(() => "?").join(",");
    remarks = getDb()
      .prepare(
        `SELECT r.id, r.user_id, r.project_id, r.path, r.line, r.category, r.body,
                r.created_at, r.resolved_at, u.name AS user_name
           FROM remarks r JOIN users u ON u.id = r.user_id
          WHERE r.project_id IN (${placeholders})
          ORDER BY r.created_at DESC`,
      )
      .all(...projectIds) as RemarkRow[];
  }

  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-12">
        <header className="mb-6 sm:mb-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Remarks
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-400">
            All remarks across every project you can see.
          </p>
        </header>
        <GlobalRemarks
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          remarks={remarks.map((r) => ({
            id: r.id,
            userId: r.user_id,
            userName: r.user_name,
            projectId: r.project_id,
            path: r.path,
            line: r.line,
            category: r.category,
            body: r.body,
            createdAt: r.created_at,
            resolvedAt: r.resolved_at,
          }))}
        />
      </main>
    </div>
  );
}
