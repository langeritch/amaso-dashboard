import { redirect } from "next/navigation";

// Legacy route. The install page lives at /install now (any signed-in
// user, not just admin) since the new flow is a Claude Code prompt
// every team member can run on their own Mac. This redirect preserves
// SettingsPanel links and operator bookmarks.
export const dynamic = "force-dynamic";

export default function AdminInstallPage(): never {
  redirect("/install");
}
