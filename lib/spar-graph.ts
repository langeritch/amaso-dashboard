// Per-user knowledge graph for the sparring partner. One JSON file per
// user, stored alongside the heartbeat under data/graph/. Spar reads the
// full graph to answer "what's on my plate"-style questions and writes
// the full graph back whenever a major event lands (new commitment, a
// blocker resolves, a milestone hit, etc.).
//
// Contract:
//   • Small and hand-authored by the model — keep entries terse.
//   • Read-modify-write is the only update pattern (see writeGraph).
//   • Schema is additive: unknown keys on disk are preserved through
//     merge, so future versions of spar can extend without breaking.

import fs from "node:fs";
import path from "node:path";

const GRAPH_DIR = path.resolve(process.cwd(), "data", "graph");

export type ProjectStatus = "active" | "paused" | "shipped" | "archived";
export type CommitmentStatus = "open" | "done" | "cancelled";
export type BlockerStatus = "open" | "resolved";
export type DecisionStatus = "open" | "decided";

export interface GraphProjectEntry {
  status: ProjectStatus;
  name?: string;
  /** Free-text notes — what the project is for, why it matters. */
  notes?: string;
  /** Ms epoch of the last meaningful change Santi flagged. */
  lastTouched?: number;
}

export interface GraphCommitment {
  id: string;
  description: string;
  /** Ms epoch. Optional — not every commitment has a hard deadline. */
  dueAt?: number;
  /** Project id this commitment relates to, if any. */
  projectId?: string;
  /** Person this commitment was made TO (e.g. a client name). */
  toWhom?: string;
  status: CommitmentStatus;
  notes?: string;
}

export interface GraphBlocker {
  id: string;
  description: string;
  projectId?: string;
  openedAt: number;
  resolvedAt?: number;
  status: BlockerStatus;
  notes?: string;
}

export interface GraphDecision {
  id: string;
  question: string;
  projectId?: string;
  status: DecisionStatus;
  /** The chosen answer, once decided. */
  decision?: string;
  notes?: string;
}

export interface GraphPerson {
  name: string;
  role?: string;
  /** Project ids this person works on / is the point of contact for. */
  projects?: string[];
  notes?: string;
}

export interface GraphConnection {
  from: string;
  to: string;
  /** Free-form relationship label: "shared_codebase", "blocks",
   *  "depends_on", "forked_from", "same_client", etc. */
  kind: string;
  note?: string;
}

export interface GraphMilestone {
  id: string;
  description: string;
  projectId?: string;
  achievedAt: number;
  notes?: string;
}

export interface SparGraph {
  version: 1;
  /** Ms epoch of the last write. */
  updatedAt: number;
  projects: Record<string, GraphProjectEntry>;
  commitments: GraphCommitment[];
  blockers: GraphBlocker[];
  decisions: GraphDecision[];
  people: Record<string, GraphPerson>;
  connections: GraphConnection[];
  milestones: GraphMilestone[];
}

function ensureDir(): void {
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
}

function pathFor(userId: number): string {
  return path.join(GRAPH_DIR, `${userId}.json`);
}

export function emptyGraph(): SparGraph {
  return {
    version: 1,
    updatedAt: 0,
    projects: {},
    commitments: [],
    blockers: [],
    decisions: [],
    people: {},
    connections: [],
    milestones: [],
  };
}

/** Read the graph for this user, returning an empty valid graph if
 *  none exists yet or the file is corrupt. */
export function readGraph(userId: number): SparGraph {
  ensureDir();
  const p = pathFor(userId);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<SparGraph>;
    return { ...emptyGraph(), ...parsed, version: 1 };
  } catch {
    return emptyGraph();
  }
}

/** Replace the whole graph file with `body`. Top-level keys present in
 *  `body` overwrite the current file; keys absent from `body` are
 *  preserved from the current on-disk state. This means the caller can
 *  do a partial update by reading first and passing the sections they
 *  changed (read-modify-write), OR a full replace by passing every
 *  section.
 *
 *  Returns the full new graph after merge. */
export function writeGraph(
  userId: number,
  body: Partial<SparGraph>,
): SparGraph {
  ensureDir();
  const current = readGraph(userId);
  const next: SparGraph = {
    ...current,
    ...body,
    version: 1,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(pathFor(userId), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** Bytes on disk — used by the UI to show a size indicator. */
export function graphSize(userId: number): number {
  try {
    return fs.statSync(pathFor(userId)).size;
  } catch {
    return 0;
  }
}
