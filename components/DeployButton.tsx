"use client";

import { useState } from "react";
import { Rocket, GitBranch, Loader2, X } from "lucide-react";

export interface GitStatusDto {
  repo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  remote: string | null;
  modified: string[];
  untracked: string[];
  staged: string[];
  conflicts: string[];
  lastCommit: { hash: string; subject: string; when: number } | null;
}

export default function DeployButton({
  projectId,
  status,
  onDone,
  isAdmin,
}: {
  projectId: string;
  status: GitStatusDto | null;
  onDone: () => void;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin || !status?.repo) return null;

  const changeCount =
    status.modified.length + status.untracked.length + status.staged.length;
  const hasChanges = changeCount > 0;
  const hasAhead = status.ahead > 0;

  // Nothing to push AND no changes to commit → button is inactive
  const actionable = hasChanges || hasAhead;

  async function deploy(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/git/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: message.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(prettyError(data.error));
        return;
      }
      setResult(
        data.committed
          ? `Committed ${data.committed} and pushed to ${data.branch}`
          : `Pushed existing commits to ${data.branch}`,
      );
      setMessage("");
      onDone();
      // Close after a short celebration
      setTimeout(() => {
        setOpen(false);
        setResult(null);
      }, 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!actionable}
        title={
          actionable
            ? `Deploy ${changeCount} change${changeCount === 1 ? "" : "s"}${
                hasAhead ? ` + ${status.ahead} unpushed commit(s)` : ""
              }`
            : "Nothing to deploy — working tree clean and branch up to date"
        }
        className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
          actionable
            ? "bg-orange-500 text-black hover:bg-orange-400"
            : "cursor-not-allowed bg-neutral-800 text-neutral-500"
        }`}
      >
        <Rocket className="h-3.5 w-3.5" />
        {actionable ? (
          <span>
            <span className="hidden sm:inline">Push to live</span>
            <span className="sm:hidden">Push</span>
            {(hasChanges || hasAhead) && (
              <span className="ml-1 rounded-full bg-black/20 px-1 text-[10px]">
                {hasChanges ? changeCount : ""}
                {hasChanges && hasAhead ? " + " : ""}
                {hasAhead ? `↑${status.ahead}` : ""}
              </span>
            )}
          </span>
        ) : (
          <span>Live</span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !pending && setOpen(false)}
        >
          <form
            onSubmit={deploy}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md space-y-3 rounded-lg border border-neutral-800 bg-neutral-950 p-5"
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="flex items-center gap-1.5 text-base font-medium">
                  <Rocket className="h-4 w-4 text-orange-400" /> Push to live
                </h2>
                <p className="mt-1 text-xs text-neutral-500">
                  Commits all changes and pushes to{" "}
                  <span className="font-mono text-neutral-300">
                    {status.branch}
                  </span>
                  . Vercel picks it up from there.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-neutral-500 hover:text-neutral-200"
                disabled={pending}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded border border-neutral-800 bg-neutral-900 p-3 text-xs">
              <div className="flex items-center gap-2 text-neutral-400">
                <GitBranch className="h-3.5 w-3.5" />
                <span className="font-mono text-neutral-200">
                  {status.branch}
                </span>
                {status.remote && (
                  <span className="truncate text-neutral-500">
                    → {shortenRemote(status.remote)}
                  </span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <Stat label="modified" n={status.modified.length} />
                <Stat label="new" n={status.untracked.length} tone="lime" />
                <Stat label="to push" n={status.ahead} tone="sky" />
              </div>
              {status.conflicts.length > 0 && (
                <p className="mt-2 text-xs text-red-400">
                  ⚠ {status.conflicts.length} unresolved conflict
                  {status.conflicts.length === 1 ? "" : "s"} — resolve first.
                </p>
              )}
            </div>

            {hasChanges && (
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">
                  Commit message
                </span>
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={`Deploy from Amaso dashboard`}
                  className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-600"
                  disabled={pending}
                />
              </label>
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}
            {result && <p className="text-sm text-orange-400">{result}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending || status.conflicts.length > 0}
                className="flex items-center gap-1.5 rounded bg-orange-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-orange-400 disabled:opacity-50"
              >
                {pending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Pushing…
                  </>
                ) : (
                  <>
                    <Rocket className="h-4 w-4" /> Push
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function Stat({
  label,
  n,
  tone = "amber",
}: {
  label: string;
  n: number;
  tone?: "amber" | "lime" | "sky";
}) {
  const style =
    tone === "amber"
      ? n > 0
        ? "text-amber-300"
        : "text-neutral-500"
      : tone === "lime"
        ? n > 0
          ? "text-lime-400"
          : "text-neutral-500"
        : n > 0
          ? "text-sky-300"
          : "text-neutral-500";
  return (
    <div>
      <div className={`text-lg font-semibold ${style}`}>{n}</div>
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
    </div>
  );
}

function shortenRemote(url: string): string {
  // git@github.com:owner/repo.git → owner/repo
  const ssh = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return ssh[1];
  // https://github.com/owner/repo.git → owner/repo
  const https = /https?:\/\/[^/]+\/(.+?)(?:\.git)?$/.exec(url);
  if (https) return https[1];
  return url;
}

function prettyError(code: string | undefined): string {
  switch (code) {
    case "not_a_repo":
      return "This project isn't a git repository.";
    case "no_remote":
      return "No git remote 'origin' is configured.";
    case "no_branch":
      return "Couldn't detect the current branch.";
    case "unresolved_conflicts":
      return "There are unresolved merge conflicts — fix them first.";
    case "project_not_found":
      return "Project not found.";
    default:
      return code ? `git error: ${code}` : "Deploy failed.";
  }
}
