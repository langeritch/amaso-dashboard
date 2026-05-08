import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import InstallApp from "@/components/InstallApp";

export const dynamic = "force-dynamic";

export default async function InstallPage() {
  const user = await requireUser();
  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-12">
        <header className="mb-6 flex flex-col gap-1.5 sm:mb-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Install Amaso Companion
          </h1>
          <p className="text-sm leading-relaxed text-neutral-500">
            Connect this Mac to Amaso. Your team members paste the prompt
            below into their own Claude Code session and the companion
            takes about a minute to set up.
          </p>
        </header>
        <InstallApp />
      </main>
    </div>
  );
}
