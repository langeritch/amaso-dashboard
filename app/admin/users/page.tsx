import { requireAdmin } from "@/lib/guard";
import { loadConfig } from "@/lib/config";
import Topbar from "@/components/Topbar";
import UsersAdmin from "@/components/UsersAdmin";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const user = await requireAdmin();
  const projects = loadConfig().projects.map((p) => ({
    id: p.id,
    name: p.name,
  }));
  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-5 flex flex-col gap-1 sm:mb-6 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-neutral-500">
            Team members see all projects. Clients see only what you grant them.
          </p>
        </header>
        <UsersAdmin projects={projects} currentUserId={user.id} />
      </main>
    </div>
  );
}
