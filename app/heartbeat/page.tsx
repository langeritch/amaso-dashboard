import { requireUser } from "@/lib/guard";
import { readHeartbeat } from "@/lib/heartbeat";
import Topbar from "@/components/Topbar";
import HeartbeatView from "@/components/HeartbeatView";

export const dynamic = "force-dynamic";

export default async function HeartbeatPage() {
  const user = await requireUser();
  const body = readHeartbeat(user.id);
  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-12">
        <header className="mb-6 flex flex-col gap-1.5 sm:mb-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Heartbeat
          </h1>
          <p className="text-sm leading-relaxed text-neutral-500">
            Live &ldquo;right now&rdquo; state plus a timeline of every cron tick.
          </p>
        </header>
        <HeartbeatView userId={user.id} initialBody={body} />
      </main>
    </div>
  );
}
