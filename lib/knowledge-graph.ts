import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Persistent per-user knowledge graph.
 *
 * Stores ENTITIES (typed nodes with free-form properties) and
 * RELATIONSHIPS (typed edges between entities). One JSON file per
 * user at `data/user-knowledge-graph/{userId}.json`. The directory
 * is gitignored — the contents are personal facts the user has
 * shared with the assistant.
 *
 * Why per-user rather than a single shared file: the dashboard is
 * multi-tenant (admin auth + sessions table), and one global file
 * would either bleed identity facts across users or need a userId
 * field on every row anyway. Per-user files also get cheap
 * concurrency: one mutex per user, no cross-user contention.
 *
 * Concurrency: read-modify-write is serialised through a per-user
 * promise chain (see `withUserLock`). Single-process only — fine
 * for the local Next.js dev server. Atomic FS writes via temp+rename
 * so a crash mid-write can't corrupt the file.
 *
 * Naming note: this module is INTENTIONALLY separate from the
 * project-entity graph at `data/graph.json` (rendered by /brain).
 * That one tracks projects/people/tech for portfolio display; this
 * one tracks personal memory about the user. No coupling; the file
 * paths are deliberately distinct.
 */

const STORE_DIR = path.resolve(process.cwd(), "data", "user-knowledge-graph");
const STORE_VERSION = 1;

// Hard cap: a runaway extractor shouldn't be able to balloon the
// file into multi-megabyte territory. When exceeded, low-priority
// entities are evicted (lowest score, see `pruneIfNeeded`).
const MAX_ENTITIES_PER_USER = 500;
const MAX_RELATIONSHIPS_PER_USER = 1500;

// ---------- types -----------------------------------------------------

export type EntityType =
  | "person"
  | "preference"
  | "routine"
  | "tool"
  | "decision"
  | "solution"
  | "project"
  | "concept";

export const ENTITY_TYPES: readonly EntityType[] = [
  "person",
  "preference",
  "routine",
  "tool",
  "decision",
  "solution",
  "project",
  "concept",
];

/**
 * How sure are we about this fact?
 *  - explicit:  user said it directly ("my name is Sander")
 *  - inferred:  we deduced it from context
 *  - corrected: user fixed a prior fact — bump priority above explicit
 *               so the corrected version always wins ranking ties
 */
export type Confidence = "explicit" | "inferred" | "corrected";

export const CONFIDENCE_LEVELS: readonly Confidence[] = [
  "explicit",
  "inferred",
  "corrected",
];

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  /** Free-form key/value bag. The shape per type is informal — the
   *  extractor and UI know the conventions, but the storage layer is
   *  intentionally permissive so new property names don't require a
   *  migration. */
  properties: Record<string, unknown>;
  confidence: Confidence;
  createdAt: number;
  updatedAt: number;
  /** Last time we re-confirmed this fact in conversation. Lets the
   *  ranker prefer recently-mentioned facts over stale ones without
   *  losing the original createdAt. */
  lastConfirmedAt: number;
  /** Verbatim excerpt from the conversation that produced this
   *  entity. Useful for audits + UI tooltips. */
  sourceExcerpt: string | null;
}

/**
 * Edge between two entities. `type` is a free-form verb phrase —
 * "uses", "worksOn", "prefers", "solves". The extractor follows a
 * lowerCamelCase convention so dedup works on identity.
 */
export interface Relationship {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  properties?: Record<string, unknown>;
  confidence: Confidence;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeGraph {
  userId: number;
  version: number;
  updatedAt: number;
  entities: Entity[];
  relationships: Relationship[];
}

// ---------- locking + atomic IO ---------------------------------------

const userLocks = new Map<number, Promise<unknown>>();

async function withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  // Chain fn onto both branches so a rejection doesn't poison later
  // waiters; the real error still propagates to this caller via
  // `next` below.
  const next = prev.then(fn, fn);
  const safe = next.catch(() => undefined);
  userLocks.set(userId, safe);
  try {
    return await next;
  } finally {
    if (userLocks.get(userId) === safe) {
      userLocks.delete(userId);
    }
  }
}

function ensureDir(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function pathFor(userId: number): string {
  return path.join(STORE_DIR, `${userId}.json`);
}

function emptyGraph(userId: number): KnowledgeGraph {
  return {
    userId,
    version: STORE_VERSION,
    updatedAt: Date.now(),
    entities: [],
    relationships: [],
  };
}

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, file);
}

function loadGraphSync(userId: number): KnowledgeGraph {
  ensureDir();
  const p = pathFor(userId);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return emptyGraph(userId);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt — rename out of the way, start fresh. We don't nuke it
    // outright in case the user wants to recover by hand later.
    try {
      fs.renameSync(p, `${p}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return emptyGraph(userId);
  }
  const obj = parsed as Partial<KnowledgeGraph>;
  if (
    !obj ||
    typeof obj !== "object" ||
    !Array.isArray(obj.entities) ||
    !Array.isArray(obj.relationships)
  ) {
    return emptyGraph(userId);
  }
  return {
    userId,
    version:
      typeof obj.version === "number" && obj.version > 0
        ? obj.version
        : STORE_VERSION,
    updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : Date.now(),
    entities: obj.entities.filter(isValidEntity),
    relationships: obj.relationships.filter(isValidRelationship),
  };
}

function saveGraphSync(graph: KnowledgeGraph): void {
  ensureDir();
  const out: KnowledgeGraph = {
    ...graph,
    updatedAt: Date.now(),
    entities: graph.entities.filter(isValidEntity),
    relationships: graph.relationships.filter(isValidRelationship),
  };
  writeAtomic(pathFor(graph.userId), JSON.stringify(out, null, 2));
}

function isValidEntity(e: unknown): e is Entity {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    typeof x.type === "string" &&
    typeof x.name === "string" &&
    typeof x.properties === "object" &&
    x.properties !== null &&
    typeof x.confidence === "string" &&
    typeof x.createdAt === "number" &&
    typeof x.updatedAt === "number"
  );
}

function isValidRelationship(r: unknown): r is Relationship {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    typeof x.fromId === "string" &&
    typeof x.toId === "string" &&
    typeof x.type === "string" &&
    typeof x.confidence === "string" &&
    typeof x.createdAt === "number" &&
    typeof x.updatedAt === "number"
  );
}

// ---------- normalization ---------------------------------------------

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Two entities are "the same" when type + normalised name match. The
 *  extractor exploits this to UPSERT — if it sees a person named
 *  "Sander" twice, the second mention merges with the first rather
 *  than duplicating. */
function entityMatchKey(e: Pick<Entity, "type" | "name">): string {
  return `${e.type}|${normName(e.name)}`;
}

function relMatchKey(
  r: Pick<Relationship, "fromId" | "toId" | "type">,
): string {
  return `${r.fromId}|${r.toId}|${normName(r.type)}`;
}

// ---------- pruning + ranking helpers ---------------------------------

const TYPE_PRIORITY: Record<EntityType, number> = {
  // Solution scores highest because the spec mandates "highest priority
  // in retrieval — if the user hits a similar problem again, surface
  // the prior solution immediately." Person second so the assistant
  // always knows who it's talking to. Concepts and projects flesh out
  // context but are evictable when space is tight.
  solution: 5,
  person: 4,
  preference: 3,
  decision: 3,
  routine: 2,
  tool: 2,
  project: 2,
  concept: 1,
};

const CONFIDENCE_SCORE: Record<Confidence, number> = {
  corrected: 1.5,
  explicit: 1.0,
  inferred: 0.5,
};

function pruneIfNeeded(graph: KnowledgeGraph): void {
  if (graph.entities.length > MAX_ENTITIES_PER_USER) {
    const scored = graph.entities.map((e) => ({
      e,
      score:
        TYPE_PRIORITY[e.type] +
        CONFIDENCE_SCORE[e.confidence] +
        e.lastConfirmedAt / 1e13,
    }));
    scored.sort((a, b) => b.score - a.score);
    const keep = scored.slice(0, MAX_ENTITIES_PER_USER).map((s) => s.e);
    const keepIds = new Set(keep.map((e) => e.id));
    graph.entities = keep;
    // Cascade: drop relationships pointing at removed entities so we
    // don't leak dangling edges. The relationships file is bounded
    // separately below.
    graph.relationships = graph.relationships.filter(
      (r) => keepIds.has(r.fromId) && keepIds.has(r.toId),
    );
  }
  if (graph.relationships.length > MAX_RELATIONSHIPS_PER_USER) {
    // Newest first — we'd rather forget old reasoning than recent
    // observations. Tie-broken by confidence.
    graph.relationships.sort((a, b) => {
      const ax = b.updatedAt - a.updatedAt;
      if (ax !== 0) return ax;
      return CONFIDENCE_SCORE[b.confidence] - CONFIDENCE_SCORE[a.confidence];
    });
    graph.relationships = graph.relationships.slice(
      0,
      MAX_RELATIONSHIPS_PER_USER,
    );
  }
}

function newId(): string {
  return crypto.randomUUID();
}

// ---------- public CRUD: reads ---------------------------------------

export async function readGraph(userId: number): Promise<KnowledgeGraph> {
  return withUserLock(userId, async () => loadGraphSync(userId));
}

export async function listEntities(
  userId: number,
  type?: EntityType,
): Promise<Entity[]> {
  const graph = await readGraph(userId);
  if (!type) return graph.entities;
  return graph.entities.filter((e) => e.type === type);
}

export async function listRelationships(
  userId: number,
): Promise<Relationship[]> {
  const graph = await readGraph(userId);
  return graph.relationships;
}

export async function getEntity(
  userId: number,
  id: string,
): Promise<Entity | null> {
  const graph = await readGraph(userId);
  return graph.entities.find((e) => e.id === id) ?? null;
}

// ---------- public CRUD: writes --------------------------------------

export interface UpsertEntityInput {
  type: EntityType;
  name: string;
  properties?: Record<string, unknown>;
  confidence?: Confidence;
  sourceExcerpt?: string | null;
  /** When set, replaces the existing properties wholesale rather than
   *  merging. Default behaviour merges so partial updates ("we now
   *  know their wakeUp time too") don't have to repeat unrelated
   *  fields. */
  replaceProperties?: boolean;
}

/**
 * Insert or merge an entity. Match key is (type, normalised name).
 * On match: properties merge (or replace), updatedAt + lastConfirmedAt
 * bump, confidence promotes if the new reading is stronger.
 */
export async function upsertEntity(
  userId: number,
  input: UpsertEntityInput,
): Promise<Entity> {
  return withUserLock(userId, async () => {
    const graph = loadGraphSync(userId);
    const now = Date.now();
    const name = input.name.trim();
    if (!name) throw new Error("upsertEntity: name is required");
    if (!ENTITY_TYPES.includes(input.type)) {
      throw new Error(`upsertEntity: invalid type ${input.type}`);
    }
    const props = input.properties ?? {};
    const conf: Confidence = input.confidence ?? "inferred";
    const key = entityMatchKey({ type: input.type, name });
    const idx = graph.entities.findIndex(
      (e) => entityMatchKey(e) === key,
    );
    if (idx >= 0) {
      const prev = graph.entities[idx];
      const merged: Entity = {
        ...prev,
        // Re-take name in case the user provided a better-cased
        // version ("sander" → "Sander").
        name,
        properties: input.replaceProperties
          ? { ...props }
          : { ...prev.properties, ...props },
        confidence: promoteConfidence(prev.confidence, conf),
        updatedAt: now,
        lastConfirmedAt: now,
        sourceExcerpt: input.sourceExcerpt ?? prev.sourceExcerpt,
      };
      graph.entities[idx] = merged;
      pruneIfNeeded(graph);
      saveGraphSync(graph);
      return merged;
    }
    const entity: Entity = {
      id: newId(),
      type: input.type,
      name,
      properties: { ...props },
      confidence: conf,
      createdAt: now,
      updatedAt: now,
      lastConfirmedAt: now,
      sourceExcerpt: input.sourceExcerpt ?? null,
    };
    graph.entities.push(entity);
    pruneIfNeeded(graph);
    saveGraphSync(graph);
    return entity;
  });
}

/** Promote returns the stronger of two confidence levels. corrected
 *  always wins, then explicit, then inferred. Used on upsert merges
 *  so a user's correction can't be downgraded by a later inference. */
function promoteConfidence(a: Confidence, b: Confidence): Confidence {
  if (a === "corrected" || b === "corrected") return "corrected";
  if (a === "explicit" || b === "explicit") return "explicit";
  return "inferred";
}

export interface UpdateEntityPatch {
  name?: string;
  type?: EntityType;
  properties?: Record<string, unknown>;
  confidence?: Confidence;
  sourceExcerpt?: string | null;
  replaceProperties?: boolean;
}

export async function updateEntity(
  userId: number,
  id: string,
  patch: UpdateEntityPatch,
): Promise<Entity | null> {
  return withUserLock(userId, async () => {
    const graph = loadGraphSync(userId);
    const idx = graph.entities.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const prev = graph.entities[idx];
    const now = Date.now();
    if (patch.type && !ENTITY_TYPES.includes(patch.type)) {
      throw new Error(`updateEntity: invalid type ${patch.type}`);
    }
    const next: Entity = {
      ...prev,
      ...(patch.type ? { type: patch.type } : {}),
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      properties: patch.properties
        ? patch.replaceProperties
          ? { ...patch.properties }
          : { ...prev.properties, ...patch.properties }
        : prev.properties,
      confidence: patch.confidence ?? prev.confidence,
      updatedAt: now,
      lastConfirmedAt: now,
      sourceExcerpt:
        patch.sourceExcerpt !== undefined
          ? patch.sourceExcerpt
          : prev.sourceExcerpt,
    };
    graph.entities[idx] = next;
    saveGraphSync(graph);
    return next;
  });
}

export async function deleteEntity(
  userId: number,
  id: string,
): Promise<boolean> {
  return withUserLock(userId, async () => {
    const graph = loadGraphSync(userId);
    const before = graph.entities.length;
    graph.entities = graph.entities.filter((e) => e.id !== id);
    if (graph.entities.length === before) return false;
    // Cascade: drop any relationships involving the deleted entity.
    graph.relationships = graph.relationships.filter(
      (r) => r.fromId !== id && r.toId !== id,
    );
    saveGraphSync(graph);
    return true;
  });
}

export interface UpsertRelationshipInput {
  fromId: string;
  toId: string;
  type: string;
  properties?: Record<string, unknown>;
  confidence?: Confidence;
}

export async function upsertRelationship(
  userId: number,
  input: UpsertRelationshipInput,
): Promise<Relationship | null> {
  return withUserLock(userId, async () => {
    const graph = loadGraphSync(userId);
    if (!input.type.trim()) {
      throw new Error("upsertRelationship: type is required");
    }
    // Validate endpoints exist — the alternative is "auto-create
    // missing entities", which sneaks in unnamed/typeless ghosts.
    // Better to fail loud and let the caller resolve the entity ids
    // first.
    const fromExists = graph.entities.some((e) => e.id === input.fromId);
    const toExists = graph.entities.some((e) => e.id === input.toId);
    if (!fromExists || !toExists) return null;
    const now = Date.now();
    const conf: Confidence = input.confidence ?? "inferred";
    const key = relMatchKey({
      fromId: input.fromId,
      toId: input.toId,
      type: input.type,
    });
    const idx = graph.relationships.findIndex((r) => relMatchKey(r) === key);
    if (idx >= 0) {
      const prev = graph.relationships[idx];
      const merged: Relationship = {
        ...prev,
        properties: { ...prev.properties, ...(input.properties ?? {}) },
        confidence: promoteConfidence(prev.confidence, conf),
        updatedAt: now,
      };
      graph.relationships[idx] = merged;
      saveGraphSync(graph);
      return merged;
    }
    const rel: Relationship = {
      id: newId(),
      fromId: input.fromId,
      toId: input.toId,
      type: input.type.trim(),
      properties: input.properties ? { ...input.properties } : undefined,
      confidence: conf,
      createdAt: now,
      updatedAt: now,
    };
    graph.relationships.push(rel);
    pruneIfNeeded(graph);
    saveGraphSync(graph);
    return rel;
  });
}

export async function deleteRelationship(
  userId: number,
  id: string,
): Promise<boolean> {
  return withUserLock(userId, async () => {
    const graph = loadGraphSync(userId);
    const before = graph.relationships.length;
    graph.relationships = graph.relationships.filter((r) => r.id !== id);
    if (graph.relationships.length === before) return false;
    saveGraphSync(graph);
    return true;
  });
}

// ---------- search / query --------------------------------------------

export interface QueryOptions {
  /** Restrict to these types (include-list). */
  types?: EntityType[];
  /** Free-text keywords; entities with name/property/excerpt matches
   *  rank higher. Substring, case-insensitive. */
  keywords?: string[];
  /** Free-text query (alternative to keywords; tokenised internally). */
  q?: string;
  /** Hard cap on returned entities (default: 80). */
  limit?: number;
}

export interface QueryResult {
  entities: Entity[];
  relationships: Relationship[];
}

/**
 * Return the subset of the graph relevant to a conversation. Ranks
 * entities by:
 *   typePriority + confidenceScore + recency + keywordHits
 * with solution+corrected always boosted. Returns the matched
 * entities AND any relationship whose endpoints are both in the
 * result — so the prompt formatter can render meaningful edges
 * without having to re-resolve ids.
 */
export async function queryGraph(
  userId: number,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const graph = await readGraph(userId);
  const limit = opts.limit ?? 80;
  const allowTypes = opts.types ? new Set(opts.types) : null;
  const keywords = collectKeywords(opts.keywords, opts.q);

  const scored: { e: Entity; score: number }[] = [];
  const now = Date.now();
  for (const e of graph.entities) {
    if (allowTypes && !allowTypes.has(e.type)) continue;
    let score = TYPE_PRIORITY[e.type] + CONFIDENCE_SCORE[e.confidence];
    // Recency boost — half-life of 30 days, on lastConfirmedAt so
    // repeated mentions keep an entity fresh.
    const ageDays = Math.max(
      0,
      (now - e.lastConfirmedAt) / (24 * 60 * 60 * 1000),
    );
    score += Math.max(0, 1 - ageDays / 30) * 0.7;
    if (keywords.length > 0) {
      const hay = entityHaystack(e);
      let hits = 0;
      for (const k of keywords) if (hay.includes(k)) hits += 1;
      // +0.4 per hit, capped — prevents one entity with five matching
      // properties from monopolising the result.
      score += Math.min(2, hits * 0.4);
    }
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const entities = scored.slice(0, limit).map((s) => s.e);
  const idSet = new Set(entities.map((e) => e.id));
  const relationships = graph.relationships.filter(
    (r) => idSet.has(r.fromId) && idSet.has(r.toId),
  );
  return { entities, relationships };
}

function collectKeywords(
  explicit: string[] | undefined,
  q: string | undefined,
): string[] {
  const out: string[] = [];
  if (explicit) {
    for (const k of explicit) {
      const v = k.toLowerCase().trim();
      if (v.length >= 2) out.push(v);
    }
  }
  if (q) {
    for (const w of q.split(/\s+/)) {
      const v = w
        .toLowerCase()
        .replace(/[^\p{L}\p{N}-]/gu, "")
        .trim();
      if (v.length >= 2) out.push(v);
    }
  }
  return out;
}

function entityHaystack(e: Entity): string {
  // Flatten name + properties + excerpt for substring search. We keep
  // it cheap (no JSON.stringify with formatting) — just a join.
  const propBits: string[] = [];
  for (const [k, v] of Object.entries(e.properties)) {
    propBits.push(k);
    if (typeof v === "string") propBits.push(v);
    else if (Array.isArray(v)) propBits.push(v.map((x) => String(x)).join(" "));
    else if (v != null) propBits.push(String(v));
  }
  return [e.name, ...propBits, e.sourceExcerpt ?? ""].join(" ").toLowerCase();
}

// ---------- prompt formatting -----------------------------------------

const TYPE_LABELS: Record<EntityType, string> = {
  person: "People",
  preference: "Preferences",
  routine: "Routines",
  tool: "Tools",
  decision: "Decisions",
  solution: "Hard-won solutions (apply these — they outrank defaults)",
  project: "Projects",
  concept: "Concepts",
};

const TYPE_ORDER: EntityType[] = [
  "solution", // surface first per spec
  "person",
  "preference",
  "routine",
  "decision",
  "tool",
  "project",
  "concept",
];

/** Render the query result as a markdown-ish block suitable for
 *  injection into the Spar system prompt. Empty input → empty string
 *  (the prompt builder skips the section entirely). */
export function formatGraphForPrompt(result: QueryResult): string {
  if (result.entities.length === 0) return "";
  const byType = new Map<EntityType, Entity[]>();
  for (const e of result.entities) {
    const arr = byType.get(e.type) ?? [];
    arr.push(e);
    byType.set(e.type, arr);
  }
  const idToName = new Map(result.entities.map((e) => [e.id, e.name]));

  const lines: string[] = [];
  for (const type of TYPE_ORDER) {
    const arr = byType.get(type);
    if (!arr || arr.length === 0) continue;
    lines.push(`${TYPE_LABELS[type]}:`);
    for (const e of arr) {
      lines.push(formatEntityLine(e));
    }
    lines.push("");
  }

  // Relationships at the end so the entities are already in the
  // model's context window when it reads "Sander uses Whisper Writer".
  if (result.relationships.length > 0) {
    lines.push("Connections:");
    for (const r of result.relationships) {
      const from = idToName.get(r.fromId);
      const to = idToName.get(r.toId);
      if (!from || !to) continue;
      lines.push(`- ${from} → ${r.type} → ${to}`);
    }
  }
  return lines.join("\n").trimEnd();
}

function formatEntityLine(e: Entity): string {
  // Solutions get a multi-line render so the structure (problem /
  // tried / works) is visible to the model.
  if (e.type === "solution") {
    const props = e.properties as {
      problem?: string;
      failedApproaches?: unknown;
      workingSolution?: string;
      resolved?: string;
    };
    const problem =
      typeof props.problem === "string" ? props.problem : e.name;
    const tried = Array.isArray(props.failedApproaches)
      ? props.failedApproaches.map((x) => String(x)).filter(Boolean)
      : [];
    const works =
      typeof props.workingSolution === "string"
        ? props.workingSolution
        : "(unrecorded)";
    const date =
      typeof props.resolved === "string" ? ` (resolved ${props.resolved})` : "";
    const out = [`- "${problem}"${date}`];
    if (tried.length > 0) out.push(`    tried: ${tried.join("; ")}`);
    out.push(`    works: ${works}`);
    return out.join("\n");
  }
  // Default: name + a compact `key=value` summary of properties.
  const propStr = Object.entries(e.properties)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(", ");
  return propStr ? `- ${e.name} (${propStr})` : `- ${e.name}`;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") {
    return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  if (Array.isArray(v)) {
    return v.map((x) => formatValue(x)).join("/");
  }
  if (typeof v === "object" && v != null) {
    return JSON.stringify(v).slice(0, 80);
  }
  return String(v);
}
