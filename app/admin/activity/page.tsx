import { redirect } from "next/navigation";

// Legacy route. The People & Activity surface lives at /activity now
// (admin-gated, team-wide). This redirect preserves the link in
// SettingsPanel and any operator bookmarks. The super-user-only live
// presence panel was rolled into the new view's people cards.
export const dynamic = "force-dynamic";

export default function AdminActivityPage(): never {
  redirect("/activity");
}
