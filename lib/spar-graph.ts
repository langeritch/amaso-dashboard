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
import { getDb } from "./db";
import { broadcastGraphChanged } from "./ws";

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
  // One-way mirror into SQLite so the brain page reflects whatever spar
  // just wrote. Failures here are non-fatal: the JSON file remains the
  // primary store and the spar tools see no error from a sync glitch.
  try {
    syncToSqlite(userId, next);
  } catch (err) {
    console.warn("[spar-graph] sqlite sync failed (non-fatal):", err);
  }
  return next;
}

// ───── SQLite mirror ──────────────────────────────────────────────────
//
// The sparring partner's per-user JSON graph is the source of truth for
// the spar agent itself. The brain page (`/brain`) renders from
// graph_nodes / graph_edges in SQLite. To keep them in step we mirror
// every spar write into SQLite under a per-user `origin` tag.
//
// Ownership rules:
//   - Project nodes share an id namespace with brain-UI-created /
//     seeded projects, so the sync only updates label/status/notes
//     and never claims ownership (origin stays NULL or whatever it
//     was). Project nodes are upserted but never deleted by sync.
//   - Person / blocker / decision nodes are scoped per user via id
//     prefixes (`spar:<uid>:person:<slug>` etc.) and tagged with
//     origin = `spar:<uid>`. Sync owns these — it can delete any
//     prefix-matching row that's no longer in this user's spar graph.
//   - Edges are tagged with origin = `spar:<uid>` and fully replaced
//     on every sync (delete-then-insert scoped to that origin), so
//     edges added or removed in spar's `connections[]` track exactly.
//
// Brain-UI-authored rows have origin=NULL and are never touched.

const PERSON_ID_PREFIX = (uid: number) => `spar:${uid}:person:`;
const BLOCKER_ID_PREFIX = (uid: number) => `spar:${uid}:blocker:`;
const DECISION_ID_PREFIX = (uid: number) => `spar:${uid}:decision:`;
const MILESTONE_ID_PREFIX = (uid: number) => `spar:${uid}:milestone:`;
const ORIGIN = (uid: number) => `spar:${uid}`;

function slug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function personId(uid: number, name: string): string {
  return PERSON_ID_PREFIX(uid) + (slug(name) || "anon");
}
function blockerId(uid: number, id: string): string {
  return BLOCKER_ID_PREFIX(uid) + (slug(id) || "x");
}
function decisionId(uid: number, id: string): string {
  return DECISION_ID_PREFIX(uid) + (slug(id) || "x");
}
function milestoneId(uid: number, id: string): string {
  return MILESTONE_ID_PREFIX(uid) + (slug(id) || "x");
}

interface ComputedNode {
  id: string;
  type: "project" | "person" | "blocker" | "decision" | "milestone";
  label: string;
  status: string | null;
  notes: string | null;
  /** True for nodes the sync owns (person/blocker/decision/milestone).
   *  False for project nodes — sync upserts them but never claims origin. */
  owned: boolean;
}

interface ComputedEdge {
  source: string;
  target: string;
  label: string | null;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function computeNodesAndEdges(
  uid: number,
  graph: SparGraph,
): { nodes: ComputedNode[]; edges: ComputedEdge[] } {
  const nodes: ComputedNode[] = [];
  const edges: ComputedEdge[] = [];
  // Track every id we'll insert so edge endpoints can be validated
  // before we hand them to SQLite (FK violation otherwise).
  const ids = new Set<string>();

  // Projects: keyed by their config id, no prefix.
  for (const [pid, entry] of Object.entries(graph.projects ?? {})) {
    nodes.push({
      id: pid,
      type: "project",
      label: clip(entry.name ?? pid, 80),
      status: entry.status ?? null,
      notes: entry.notes ?? null,
      owned: false,
    });
    ids.add(pid);
  }

  // People: keyed by their name in the spar graph. Edges from each
  // person to every project they're tagged on.
  for (const [name, person] of Object.entries(graph.people ?? {})) {
    const id = personId(uid, name);
    nodes.push({
      id,
      type: "person",
      label: clip(name, 60),
      status: person.role ?? null,
      notes: person.notes ?? null,
      owned: true,
    });
    ids.add(id);
    for (const projId of person.projects ?? []) {
      // Edge created lazily — the project may not exist in graph.projects
      // (spar is allowed to reference an out-of-graph project id) but if
      // it doesn't appear in graph_nodes the FK will reject. We filter
      // unresolvable endpoints in the writer below.
      edges.push({ source: id, target: projId, label: "works_on" });
    }
  }

  // Blockers: each becomes a node, plus an edge to its project if set.
  for (const b of graph.blockers ?? []) {
    const id = blockerId(uid, b.id);
    nodes.push({
      id,
      type: "blocker",
      label: clip(b.description, 80),
      status: b.status,
      notes: b.notes ?? null,
      owned: true,
    });
    ids.add(id);
    if (b.projectId) {
      edges.push({ source: id, target: b.projectId, label: "blocks" });
    }
  }

  // Decisions: each becomes a node, plus an edge to its project if set.
  for (const d of graph.decisions ?? []) {
    const id = decisionId(uid, d.id);
    nodes.push({
      id,
      type: "decision",
      label: clip(d.question, 80),
      status: d.status,
      notes: d.decision ?? d.notes ?? null,
      owned: true,
    });
    ids.add(id);
    if (d.projectId) {
      edges.push({ source: id, target: d.projectId, label: "for" });
    }
  }

  // Milestones: each becomes a node, plus an edge to its project if set.
  // achievedAt is whatever the spar wrote (epoch ms in the canonical
  // schema, but old entries hand-wrote ISO date strings — we tolerate
  // both by funnelling through String()). It surfaces as the node
  // status so the brain page panel shows when it landed.
  for (const m of graph.milestones ?? []) {
    const id = milestoneId(uid, m.id);
    const achieved =
      typeof m.achievedAt === "number"
        ? new Date(m.achievedAt).toISOString().slice(0, 10)
        : m.achievedAt
          ? String(m.achievedAt)
          : null;
    nodes.push({
      id,
      type: "milestone",
      label: clip(m.description, 80),
      status: achieved,
      notes: m.notes ?? null,
      owned: true,
    });
    ids.add(id);
    if (m.projectId) {
      edges.push({ source: id, target: m.projectId, label: "milestone_of" });
    }
  }

  // Free-form connections: spar uses entity keys (project id, person
  // name, blocker/decision/milestone id). Resolve each endpoint to
  // whatever SQLite id we've just generated.
  const resolveEndpoint = (key: string): string | null => {
    if (graph.projects?.[key]) return key;
    if (graph.people?.[key]) return personId(uid, key);
    const b = (graph.blockers ?? []).find((x) => x.id === key);
    if (b) return blockerId(uid, b.id);
    const d = (graph.decisions ?? []).find((x) => x.id === key);
    if (d) return decisionId(uid, d.id);
    const m = (graph.milestones ?? []).find((x) => x.id === key);
    if (m) return milestoneId(uid, m.id);
    return null;
  };
  for (const c of graph.connections ?? []) {
    const src = resolveEndpoint(c.from);
    const tgt = resolveEndpoint(c.to);
    if (!src || !tgt) continue;
    if (src === tgt) continue;
    edges.push({ source: src, target: tgt, label: c.kind || null });
  }

  // Filter edges to those with both endpoints present in our computed
  // node set OR already in graph_nodes. We only hold the in-flight set
  // here; the writer below cross-checks against the live table for the
  // existing-but-not-in-this-write case.
  return { nodes, edges };
}

function syncToSqlite(userId: number, graph: SparGraph): void {
  const db = getDb();
  const origin = ORIGIN(userId);
  const { nodes, edges } = computeNodesAndEdges(userId, graph);
  const now = Date.now();

  // UPSERT for project nodes that DON'T claim ownership (preserve any
  // brain-UI authorship of label/status/notes? No — sync is the latest
  // word on what the spar believes, so it overwrites the data fields.
  // The `origin` column is the only thing we leave alone, since that's
  // the deletion gate). For owned (person/blocker/decision) nodes we
  // also stamp origin=spar:<uid>.
  const upsertProject = db.prepare(
    `INSERT INTO graph_nodes (id, type, label, status, notes, claude_md, updated_at, origin)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       type       = excluded.type,
       label      = excluded.label,
       status     = excluded.status,
       notes      = excluded.notes,
       updated_at = excluded.updated_at`,
  );
  const upsertOwned = db.prepare(
    `INSERT INTO graph_nodes (id, type, label, status, notes, claude_md, updated_at, origin)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type       = excluded.type,
       label      = excluded.label,
       status     = excluded.status,
       notes      = excluded.notes,
       updated_at = excluded.updated_at,
       origin     = excluded.origin`,
  );

  const ownedIds = nodes.filter((n) => n.owned).map((n) => n.id);
  const tx = db.transaction(() => {
    for (const n of nodes) {
      if (n.owned) {
        upsertOwned.run(n.id, n.type, n.label, n.status, n.notes, now, origin);
      } else {
        upsertProject.run(n.id, n.type, n.label, n.status, n.notes, now);
      }
    }
    // Drop owned nodes that disappeared from this user's spar graph
    // since the last sync. Edges referencing them ON DELETE CASCADE.
    if (ownedIds.length === 0) {
      db.prepare("DELETE FROM graph_nodes WHERE origin = ?").run(origin);
    } else {
      const placeholders = ownedIds.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM graph_nodes WHERE origin = ? AND id NOT IN (${placeholders})`,
      ).run(origin, ...ownedIds);
    }

    // Edges: full replace within this user's origin. Cheaper and
    // simpler than diffing — edge counts are tiny in practice.
    db.prepare("DELETE FROM graph_edges WHERE origin = ?").run(origin);
    // Endpoints must exist in graph_nodes after the upserts above. If
    // a connection points at an out-of-graph project id we skip it.
    const exists = db.prepare("SELECT 1 FROM graph_nodes WHERE id = ?");
    const insertEdge = db.prepare(
      "INSERT INTO graph_edges (source, target, label, origin) VALUES (?, ?, ?, ?)",
    );
    for (const e of edges) {
      if (!exists.get(e.source) || !exists.get(e.target)) continue;
      insertEdge.run(e.source, e.target, e.label, origin);
    }
  });
  tx();

  try {
    broadcastGraphChanged();
  } catch (err) {
    console.warn("[spar-graph] graph:changed broadcast failed:", err);
  }
}

/** Bytes on disk — used by the UI to show a size indicator. */
export function graphSize(userId: number): number {
  try {
    return fs.statSync(pathFor(userId)).size;
  } catch {
    return 0;
  }
}
