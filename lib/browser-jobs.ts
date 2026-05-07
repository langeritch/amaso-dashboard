/**
 * Browser Jobs registry.
 *
 * Tracks long-running browser-automation tasks the sparring partner
 * is driving (filling forms, setting up accounts, navigating sites)
 * so the workers panel can render them next to the terminal sessions.
 * The agent registers a job before starting the browser actions, then
 * polls back every couple of minutes via update_browser_job until the
 * goal is reached and complete_browser_job lands.
 *
 * In-memory only. The register / update / complete cycle is bounded
 * by a 1-hour idle TTL: any job that hasn't been touched (registered,
 * updated, or completed) for an hour is swept on the next read. That
 * keeps a runaway agent from filling the registry with zombies if it
 * forgets to mark a job done.
 *
 * Per user. The dashboard is multi-user; one user's browser job
 * shouldn't leak into another user's workers panel.
 */
import crypto from "node:crypto";

export type BrowserJobStatus =
  | "running"
  | "checking"
  | "done"
  | "failed"
  | "stalled";

export interface BrowserJob {
  id: string;
  userId: number;
  /** Human-readable label rendered in the workers panel. */
  name: string;
  /** What "done" looks like, in the agent's own words. Surfaces in the
   *  hover card so the operator can sanity-check whether the job has
   *  actually finished. */
  goal: string;
  status: BrowserJobStatus;
  /** Latest agent-supplied status text. Populated by update_browser_job
   *  and shown under the job name. Empty string until the first check. */
  progress: string;
  /** Wall clocks, ms-since-epoch. */
  startedAt: number;
  lastCheckedAt: number;
  completedAt: number | null;
  /** How often the agent intends to check back. Pure metadata; the
   *  registry doesn't enforce it. Default 2 minutes; the panel shows
   *  it so the operator knows roughly when the next progress line
   *  should land. */
  checkIntervalMs: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 120_000;
const JOB_TTL_MS = 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __amasoBrowserJobs: Map<number, Map<string, BrowserJob>> | undefined;
}

function store(): Map<number, Map<string, BrowserJob>> {
  if (!globalThis.__amasoBrowserJobs) {
    globalThis.__amasoBrowserJobs = new Map();
  }
  return globalThis.__amasoBrowserJobs;
}

function jobsFor(userId: number): Map<string, BrowserJob> {
  const all = store();
  let mine = all.get(userId);
  if (!mine) {
    mine = new Map();
    all.set(userId, mine);
  }
  return mine;
}

/**
 * Sweep idle jobs. Called from every read so the registry stays clean
 * without a separate timer. Idle = no register / update / complete
 * activity within JOB_TTL_MS, regardless of status. Done / failed /
 * stalled jobs that landed within the last 5 minutes are kept around
 * so the panel can fade them out gracefully.
 */
function sweep(userId: number): void {
  const mine = jobsFor(userId);
  const now = Date.now();
  for (const [id, job] of mine) {
    const idle = now - Math.max(job.lastCheckedAt, job.startedAt);
    if (idle > JOB_TTL_MS) {
      mine.delete(id);
      continue;
    }
    // Hard cap: after 5 minutes in a terminal state, drop the job so
    // the panel doesn't accumulate stale rows. The UI already fades
    // them out at the same boundary; this aligns server side.
    if (
      (job.status === "done" ||
        job.status === "failed" ||
        job.status === "stalled") &&
      job.completedAt != null &&
      now - job.completedAt > 5 * 60 * 1000
    ) {
      mine.delete(id);
    }
  }
}

export interface RegisterJobInput {
  userId: number;
  name: string;
  goal: string;
  checkIntervalMs?: number;
}

export function registerJob(input: RegisterJobInput): BrowserJob {
  const id = `bjb_${crypto.randomBytes(6).toString("base64url")}`;
  const now = Date.now();
  const job: BrowserJob = {
    id,
    userId: input.userId,
    name: input.name.trim().slice(0, 200),
    goal: input.goal.trim().slice(0, 2000),
    status: "running",
    progress: "",
    startedAt: now,
    lastCheckedAt: now,
    completedAt: null,
    checkIntervalMs:
      typeof input.checkIntervalMs === "number" &&
      Number.isFinite(input.checkIntervalMs) &&
      input.checkIntervalMs >= 5_000
        ? Math.floor(input.checkIntervalMs)
        : DEFAULT_CHECK_INTERVAL_MS,
  };
  jobsFor(input.userId).set(id, job);
  return job;
}

export interface UpdateJobInput {
  status?: BrowserJobStatus;
  progress?: string;
  /** When true, treat the update as a fresh check (bumps lastCheckedAt
   *  but doesn't change status). Useful for the "I'm still working"
   *  signal between meaningful state changes. */
  touch?: boolean;
}

export function updateJob(
  userId: number,
  id: string,
  update: UpdateJobInput,
): BrowserJob | null {
  const job = jobsFor(userId).get(id);
  if (!job) return null;
  if (update.status) {
    job.status = update.status;
    if (
      update.status === "done" ||
      update.status === "failed" ||
      update.status === "stalled"
    ) {
      job.completedAt = job.completedAt ?? Date.now();
    } else {
      job.completedAt = null;
    }
  }
  if (typeof update.progress === "string") {
    job.progress = update.progress.trim().slice(0, 2000);
  }
  if (update.touch || update.status === "checking" || update.progress) {
    job.lastCheckedAt = Date.now();
  }
  return job;
}

export function completeJob(userId: number, id: string): BrowserJob | null {
  return updateJob(userId, id, { status: "done", touch: true });
}

export function failJob(
  userId: number,
  id: string,
  reason?: string,
): BrowserJob | null {
  return updateJob(userId, id, {
    status: "failed",
    progress: reason ?? undefined,
    touch: true,
  });
}

export function getJob(userId: number, id: string): BrowserJob | null {
  sweep(userId);
  return jobsFor(userId).get(id) ?? null;
}

/** Active = anything still in the registry after the sweep. The panel
 *  filters terminal-state rows older than 5 minutes itself, but the
 *  sweep handles the hard cap so the registry can't grow unboundedly. */
export function getActiveJobs(userId: number): BrowserJob[] {
  sweep(userId);
  return Array.from(jobsFor(userId).values()).sort(
    (a, b) => b.startedAt - a.startedAt,
  );
}

export function deleteJob(userId: number, id: string): boolean {
  return jobsFor(userId).delete(id);
}
