import { notFound } from "next/navigation";
import { requireUser } from "@/lib/guard";
import { getSession, listEvents } from "@/lib/recording";
import Topbar from "@/components/Topbar";
import RecordingDetailClient from "@/components/RecordingDetailClient";

export const dynamic = "force-dynamic";

export default async function RecordingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const session = getSession(id, user.id);
  if (!session) notFound();
  const events = listEvents(id);
  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <RecordingDetailClient session={session} initialEvents={events} />
    </div>
  );
}
