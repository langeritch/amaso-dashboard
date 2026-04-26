// Minimal git helpers for per-project status + deploy. Uses `git` on PATH;
// no native bindings. Each exec is scoped to the project directory so we
// never touch a different repo by accident.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getProject } from "./config";

const exec = promisify(execFile);

export interface GitStatus {
  repo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  remote: string | null;
  modified: string[]; // relative paths
  untracked: string[];
  staged: string[];
  conflicts: string[];
  lastCommit: { hash: string; subject: string; when: number } | null;
}

async function git(
  projectPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, {
    cwd: projectPath,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

export async function getGitStatus(projectId: string): Promise<GitStatus> {
  const project = getProject(projectId);
  if (!project) throw new Error("project_not_found");
  const empty: GitStatus = {
    repo: false,
    branch: null,
    ahead: 0,
    behind: 0,
    remote: null,
    modified: [],
    untracked: [],
    staged: [],
    conflicts: [],
    lastCommit: null,
  };

  // Is this even a git repo?
  try {
    await git(project.path, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return empty;
  }
  empty.repo = true;

  // Status — porcelain v1 with branch info
  const [status, branchName, lastCommit, remoteUrl] = await Promise.all([
    // Default untracked-files mode (normal) collapses entirely-untracked
    // directories into a single entry — crucial when something like
    // .claude/worktrees/ has thousands of files inside.
    git(project.path, ["status", "--porcelain=1", "-b"]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
    git(project.path, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
    git(project.path, [
      "log",
      "-1",
      "--pretty=format:%H%x00%s%x00%ct",
    ]).catch(() => ({ stdout: "", stderr: "" })),
    git(project.path, ["remote", "get-url", "origin"]).catch(() => ({
      stdout: "",
      stderr: "",
    })),
  ]);

  empty.branch = branchName.stdout.trim() || null;
  empty.remote = remoteUrl.stdout.trim() || null;

  if (lastCommit.stdout) {
    const [hash, subject, ct] = lastCommit.stdout.split("\x00");
    if (hash) {
      empty.lastCommit = {
        hash: hash.slice(0, 12),
        subject: subject ?? "",
        when: Number(ct ?? 0) * 1000,
      };
    }
  }

  const modified: string[] = [];
  const untracked: string[] = [];
  const staged: string[] = [];
  const conflicts: string[] = [];

  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("##")) {
      // "## main...origin/main [ahead 2, behind 1]" or variants
      const m = /\[ahead (\d+)(?:, behind (\d+))?\]/.exec(line);
      if (m) {
        empty.ahead = Number(m[1]);
        if (m[2]) empty.behind = Number(m[2]);
      }
      const b2 = /\[behind (\d+)\]/.exec(line);
      if (b2 && !m) empty.behind = Number(b2[1]);
      continue;
    }
    const x = line[0];
    const y = line[1];
    const relPath = line.slice(3).split(" -> ").pop()!; // handle renames
    if (x === "?" && y === "?") {
      untracked.push(relPath);
    } else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicts.push(relPath);
    } else {
      if (x !== " " && x !== "?") staged.push(relPath);
      if (y !== " " && y !== "?") modified.push(relPath);
    }
  }

  empty.modified = modified;
  empty.untracked = untracked;
  empty.staged = staged;
  empty.conflicts = conflicts;
  return empty;
}

export interface DeployResult {
  committed: string | null; // commit hash, null if nothing to commit
  pushed: boolean;
  pushOutput: string;
  branch: string;
  remote: string;
}

/**
 * Stage all changes, commit with the given message, and push to `origin`.
 * Fails loudly if there are unresolved conflicts or no remote.
 *
 * Vercel-connected repos auto-deploy from the tracking branch, so a
 * successful push = deploy triggered.
 */
export async function commitAndPush(
  projectId: string,
  message: string,
): Promise<DeployResult> {
  const project = getProject(projectId);
  if (!project) throw new Error("project_not_found");
  const status = await getGitStatus(projectId);
  if (!status.repo) throw new Error("not_a_repo");
  if (status.conflicts.length > 0) throw new Error("unresolved_conflicts");
  if (!status.remote) throw new Error("no_remote");
  if (!status.branch) throw new Error("no_branch");

  const branch = project.deployBranch ?? status.branch;

  let committed: string | null = null;
  const hasChanges =
    status.modified.length + status.untracked.length + status.staged.length > 0;
  if (hasChanges) {
    await git(project.path, ["add", "-A"]);
    await git(project.path, ["commit", "-m", message]);
    const head = await git(project.path, ["rev-parse", "HEAD"]);
    committed = head.stdout.trim().slice(0, 12);
  }

  const push = await git(project.path, ["push", "origin", branch]);
  return {
    committed,
    pushed: true,
    pushOutput: [push.stdout, push.stderr].filter(Boolean).join("\n").trim(),
    branch,
    remote: status.remote,
  };
}
