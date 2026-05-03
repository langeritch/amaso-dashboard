import { requireAdmin } from "@/lib/guard";
import { isSuperUser } from "@/lib/heartbeat";
import { loadConfig } from "@/lib/config";
import Topbar from "@/components/Topbar";
import UsersAdmin from "@/components/UsersAdmin";
import PeopleActivity from "@/components/PeopleActivity";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const user = await requireAdmin();
  const projects = loadConfig().projects.map((p) => ({
    id: p.id,
    name: p.name,
  }));
  // The activity feed endpoint is super-user-only — gating server-side
  // matches that and avoids a 403 dance for other admins.
  const showActivity = isSuperUser(user);
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
        {showActivity && (
          <section className="mb-6">
            <header className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
                Recent activity
              </h2>
              <a
                href="/activity"
                className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
              >
                Full feed →
              </a>
            </header>
            <PeopleActivity projects={projects} />
          </section>
        )}
        <UsersAdmin projects={projects} currentUserId={user.id} />
      </main>
    </div>
  );
}
