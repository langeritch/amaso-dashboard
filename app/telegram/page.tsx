import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import TelegramCallView from "@/components/TelegramCallView";

export const dynamic = "force-dynamic";

export default async function TelegramPage() {
  const user = await requireUser();
  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <TelegramCallView isAdmin={user.role === "admin"} />
    </div>
  );
}
