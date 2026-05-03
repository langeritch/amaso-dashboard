import { requireAdmin } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import Spar2Pane from "@/components/Spar2Pane";

export const dynamic = "force-dynamic";

/**
 * /spar2 — experimental v2 sparring partner backed by Hermes Agent
 * running inside WSL2 tmux. v1 (/spar) is unchanged and remains the
 * default. The intent is to let v2 stabilise on its own without
 * regressing v1's chat/voice flow.
 *
 * Admin-only: the WS endpoint behind this page (/api/spar2) hands a
 * live root shell over the wire — see lib/spar2-ws.ts for the auth
 * + Origin guard + role check. The page-level guard mirrors that
 * (the comment used to claim admin-only without enforcing it; now
 * the page redirects non-admins via requireAdmin).
 */
export default async function Spar2Page() {
  const user = await requireAdmin();
  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <Spar2Pane />
    </div>
  );
}
