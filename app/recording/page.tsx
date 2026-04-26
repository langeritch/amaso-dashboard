import Link from "next/link";
import { requireUser } from "@/lib/guard";
import { listSessions } from "@/lib/recording";
import Topbar from "@/components/Topbar";

export const dynamic = "force-dynamic";

export default async function RecordingListPage() {
  const user = await requireUser();
  const sessions = listSessions(user.id);
  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <main className="flex-1 overflow-y-auto bg-neutral-950 text-neutral-100">
        <div className="mx-auto max-w-3xl px-4 py-8">
          <header className="mb-6 flex items-baseline justify-between">
            <h1 className="text-lg font-medium">Recordings</h1>
            <span className="text-xs text-neutral-500">{sessions.length} total</span>
          </header>
          {sessions.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No recordings yet. Click the red circle in the header to start
              one — Chrome will launch with the recorder extension loaded.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="rounded-lg border border-neutral-800 bg-neutral-900/50"
                >
                  <Link
                    href={`/recording/${s.id}`}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-neutral-900"
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${
                        s.status === "active"
                          ? "bg-red-500 animate-pulse"
                          : "bg-neutral-600"
                      }`}
                      aria-label={s.status}
                    />
                    <span className="flex flex-col text-sm">
                      <span className="text-neutral-200">
                        {s.name ?? (
                          <span className="font-mono text-[11px] text-neutral-400">
                            {s.id.slice(0, 8)}…
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-neutral-400">
                        {fmtDate(s.startedAt)}
                        {s.endedAt
                          ? ` → ${fmtTime(s.endedAt)}`
                          : " · in progress"}
                      </span>
                    </span>
                    <span className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
                      <span>{s.eventCount} events</span>
                      {s.analysisStatus && (
                        <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-300">
                          analysis {s.analysisStatus}
                        </span>
                      )}
                      {s.needsClarificationCount > 0 && (
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">
                          {s.needsClarificationCount} to clarify
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString();
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
