import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import BrowserViewer from "@/components/BrowserViewer";

export const dynamic = "force-dynamic";

export default async function BrowserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const recordingRaw = sp.recording;
  const recordingId = Array.isArray(recordingRaw)
    ? recordingRaw[0]
    : recordingRaw ?? null;
  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <BrowserViewer recordingId={recordingId} />
    </div>
  );
}
