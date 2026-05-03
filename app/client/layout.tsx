// Client portal owns its own layout below the root <html>/<body>. The
// root layout already excluded clients from SparProvider, so all the
// portal needs is the shared chrome (header, sign-out) wrapped around
// the children. No Topbar — the Topbar is internal-tool nav with
// surfaces clients are intentionally walled off from (Spar, Brain,
// Heartbeat, Activity, Settings…).

import ClientShell from "@/components/client/ClientShell";
import { requireClient } from "@/lib/guard";

export default async function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireClient();
  return <ClientShell user={user}>{children}</ClientShell>;
}
