import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser();
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <Topbar user={user} />
      <main className="flex flex-1 items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-neutral-100 sm:text-5xl">
            Home
          </h1>
          <p className="mt-3 text-sm text-neutral-500">Coming soon</p>
        </div>
      </main>
    </div>
  );
}
