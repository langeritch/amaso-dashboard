import { requireAdmin } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import InstallApp from "@/components/InstallApp";

export const dynamic = "force-dynamic";

export default async function AdminInstallPage() {
  const user = await requireAdmin();
  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-12">
        <header className="mb-6 flex flex-col gap-1.5 sm:mb-8 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Install app
          </h1>
          <p className="text-sm leading-relaxed text-neutral-500">
            Put Amaso on your home screen or dock — both options stay in sync
            with the live dashboard.
          </p>
        </header>
        <InstallApp />
      </main>
    </div>
  );
}
