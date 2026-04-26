import { redirect } from "next/navigation";
import { requireUser } from "@/lib/guard";
import { isSuperUser } from "@/lib/heartbeat";
import Topbar from "@/components/Topbar";
import ActivityPanel from "@/components/ActivityPanel";

export const dynamic = "force-dynamic";

export default async function AdminActivityPage() {
  const user = await requireUser();
  // Hard gate: only the super-user gets here. Other admins see the
  // not-found bounce so the page's existence isn't even disclosed.
  if (!isSuperUser(user)) redirect("/");
  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Activity
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            Live view of who&rsquo;s connected, where they are, and what
            they&rsquo;ve been doing.
          </p>
        </header>
        <ActivityPanel />
      </main>
    </div>
  );
}
