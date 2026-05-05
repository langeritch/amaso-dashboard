import { requireAdmin } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import UnifiedActivityFeed from "@/components/UnifiedActivityFeed";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  // Admin gate (not super-user). The legacy /admin/activity remains
  // super-user-only because it exposes per-tab session info; this page
  // sticks to team-wide aggregates that any admin can see.
  const user = await requireAdmin();
  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            People &amp; Activity
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            Cross-team timeline — dispatches, remarks, file changes, and
            who&rsquo;s online.
          </p>
        </header>
        <UnifiedActivityFeed />
      </main>
    </div>
  );
}
