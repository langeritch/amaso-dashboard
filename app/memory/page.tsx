import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Memory now lives as a tab inside /brain. Redirect so bookmarks,
// pasted links, and any in-app references still land somewhere sane.
export default function MemoryPage() {
  redirect("/brain?tab=memory");
}
