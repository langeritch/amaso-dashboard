import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import SparFullView from "@/components/SparFullView";

export const dynamic = "force-dynamic";

export default async function SparPage() {
  // requireUser still gates the route (redirects to /login or /setup);
  // SparProvider itself is mounted in the root layout once the cookie
  // resolves to a real user, so the full view just consumes context.
  const user = await requireUser();
  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <SparFullView />
    </div>
  );
}
