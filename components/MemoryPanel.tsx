"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";

// API shapes — kept loose; the route returns a richer object than
// we strictly use but extra fields don't hurt.
type Confidence = "explicit" | "inferred" | "corrected";

type EntityType =
  | "person"
  | "preference"
  | "routine"
  | "tool"
  | "decision"
  | "solution"
  | "project"
  | "concept";

interface Entity {
  id: string;
  type: EntityType;
  name: string;
  properties: Record<string, unknown>;
  confidence: Confidence;
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt: number;
  sourceExcerpt: string | null;
}

interface Relationship {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  confidence: Confidence;
  createdAt: number;
  updatedAt: number;
}

// Mirrors lib/knowledge-graph TYPE_ORDER so the dashboard reads in
// the same priority the assistant uses internally — solutions first.
const TYPE_ORDER: EntityType[] = [
  "solution",
  "person",
  "preference",
  "routine",
  "decision",
  "tool",
  "project",
  "concept",
];

const TYPE_LABEL: Record<EntityType, string> = {
  solution: "Hard-won solutions",
  person: "People",
  preference: "Preferences",
  routine: "Routines",
  decision: "Decisions",
  tool: "Tools",
  project: "Projects",
  concept: "Concepts",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  explicit: "explicit",
  inferred: "inferred",
  corrected: "corrected",
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  // Greens for facts the user stated directly. Amber for what we
  // guessed (so the user can spot-correct it). Sky for corrections,
  // since they outrank explicit and we want the eye to find them.
  explicit: "border-orange-700/60 bg-orange-900/30 text-orange-300",
  inferred: "border-amber-700/60 bg-amber-900/30 text-amber-300",
  corrected: "border-sky-700/60 bg-sky-900/30 text-sky-300",
};

export default function MemoryPanel() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // raw=1 returns the full graph (no ranking) so the UI can do
      // its own grouping + filtering. The list is bounded server-
      // side at 500 entities, well within what a single client view
      // can render comfortably.
      const r = await fetch("/api/knowledge?raw=1", { cache: "no-store" });
      if (!r.ok) {
        const text = await r.text().catch(() => "load failed");
        setError(text.slice(0, 200));
        return;
      }
      const data = (await r.json()) as {
        entities: Entity[];
        relationships: Relationship[];
      };
      setEntities(data.entities ?? []);
      setRelationships(data.relationships ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? entities.filter((e) => entityMatchesSearch(e, q))
      : entities;
    const map = new Map<EntityType, Entity[]>();
    for (const e of filtered) {
      const arr = map.get(e.type) ?? [];
      arr.push(e);
      map.set(e.type, arr);
    }
    for (const arr of map.values()) {
      // Within a type, sort by recency of confirmation. Solutions
      // resolved more recently sit at the top; oldest fact-of-life
      // entries (your name) end up further down — they're stable so
      // they don't need to be the eye's first stop.
      arr.sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt);
    }
    return map;
  }, [entities, search]);

  const onDelete = useCallback(
    async (id: string) => {
      // Optimistic remove with revert on failure. Avoids a flicker
      // where the row stays put while we wait for the round-trip.
      const prevEntities = entities;
      const prevRels = relationships;
      setEntities((es) => es.filter((e) => e.id !== id));
      setRelationships((rs) =>
        rs.filter((r) => r.fromId !== id && r.toId !== id),
      );
      try {
        const r = await fetch(`/api/knowledge/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!r.ok && r.status !== 204) {
          throw new Error(await r.text().catch(() => "delete failed"));
        }
      } catch (err) {
        setEntities(prevEntities);
        setRelationships(prevRels);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [entities, relationships],
  );

  const onSaveEdit = useCallback(
    async (id: string, patch: Partial<Entity>) => {
      try {
        const r = await fetch(`/api/knowledge/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!r.ok) {
          throw new Error(await r.text().catch(() => "update failed"));
        }
        const data = (await r.json()) as { entity: Entity };
        setEntities((es) => es.map((e) => (e.id === id ? data.entity : e)));
        setEditingId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name, property, or excerpt…"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-600"
          />
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900"
          title="Reload memory"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
        <SummaryBadge entities={entities} relationships={relationships} />
      </div>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && entities.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-8 text-center text-sm text-neutral-400">
          Loading memory…
        </div>
      ) : entities.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-5">
          {TYPE_ORDER.map((type) => {
            const arr = grouped.get(type);
            if (!arr || arr.length === 0) return null;
            return (
              <Section
                key={type}
                type={type}
                entities={arr}
                editingId={editingId}
                onEditStart={(id) => setEditingId(id)}
                onEditCancel={() => setEditingId(null)}
                onSaveEdit={onSaveEdit}
                onDelete={onDelete}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function entityMatchesSearch(e: Entity, q: string): boolean {
  if (e.name.toLowerCase().includes(q)) return true;
  if (e.type.toLowerCase().includes(q)) return true;
  if (e.sourceExcerpt && e.sourceExcerpt.toLowerCase().includes(q)) return true;
  for (const [k, v] of Object.entries(e.properties)) {
    if (k.toLowerCase().includes(q)) return true;
    if (typeof v === "string" && v.toLowerCase().includes(q)) return true;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string" && x.toLowerCase().includes(q)) return true;
      }
    }
  }
  return false;
}

function SummaryBadge({
  entities,
  relationships,
}: {
  entities: Entity[];
  relationships: Relationship[];
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <Brain className="h-3.5 w-3.5" />
      <span>
        {entities.length} {entities.length === 1 ? "entity" : "entities"} ·{" "}
        {relationships.length}{" "}
        {relationships.length === 1 ? "connection" : "connections"}
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-10 text-center text-sm text-neutral-400">
      <Brain className="mx-auto mb-3 h-6 w-6 text-neutral-500" />
      <p className="font-medium text-neutral-300">Nothing learned yet.</p>
      <p className="mt-1">
        Have a conversation in /spar — facts the assistant picks up will
        appear here.
      </p>
    </div>
  );
}

function Section({
  type,
  entities,
  editingId,
  onEditStart,
  onEditCancel,
  onSaveEdit,
  onDelete,
}: {
  type: EntityType;
  entities: Entity[];
  editingId: string | null;
  onEditStart: (id: string) => void;
  onEditCancel: () => void;
  onSaveEdit: (id: string, patch: Partial<Entity>) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-950/60">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium text-neutral-200 hover:bg-neutral-900/40"
        aria-expanded={!collapsed}
      >
        <span className="flex items-center gap-2">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-neutral-500" />
          ) : (
            <ChevronDown className="h-4 w-4 text-neutral-500" />
          )}
          <span>{TYPE_LABEL[type]}</span>
          <span className="rounded-full border border-neutral-800 px-2 py-0.5 text-[10px] font-normal text-neutral-500">
            {entities.length}
          </span>
        </span>
      </button>
      {!collapsed && (
        <ul className="divide-y divide-neutral-800/80 border-t border-neutral-800">
          {entities.map((e) => (
            <li key={e.id} className="px-4 py-3">
              {editingId === e.id ? (
                <EditRow
                  entity={e}
                  onCancel={onEditCancel}
                  onSave={(patch) => onSaveEdit(e.id, patch)}
                />
              ) : (
                <ViewRow
                  entity={e}
                  onEdit={() => onEditStart(e.id)}
                  onDelete={() => onDelete(e.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ViewRow({
  entity,
  onEdit,
  onDelete,
}: {
  entity: Entity;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {entity.type === "solution" && (
            <Lightbulb className="h-4 w-4 flex-shrink-0 text-amber-400" />
          )}
          <h3 className="truncate text-sm font-medium text-neutral-100">
            {entity.name || "(unnamed)"}
          </h3>
          <ConfidenceBadge confidence={entity.confidence} />
          <span
            className="text-[10px] text-neutral-500"
            title={`Last confirmed ${new Date(entity.lastConfirmedAt).toLocaleString()}`}
          >
            {humanAgo(entity.lastConfirmedAt)}
          </span>
        </div>
        <PropertiesView entity={entity} />
        {entity.sourceExcerpt && (
          <p className="mt-2 line-clamp-2 text-xs italic text-neutral-500">
            “{entity.sourceExcerpt}”
          </p>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          className="rounded p-1.5 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
          title="Edit"
          aria-label="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Forget "${entity.name}"?`)) onDelete();
          }}
          className="rounded p-1.5 text-neutral-500 transition hover:bg-red-950/40 hover:text-red-300"
          title="Delete"
          aria-label="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function PropertiesView({ entity }: { entity: Entity }) {
  // Solutions get a structured render — the spec calls them out as
  // the highest-value memories, so we don't bury problem/works in a
  // generic key=value list.
  if (entity.type === "solution") {
    const props = entity.properties as {
      problem?: string;
      failedApproaches?: unknown;
      workingSolution?: string;
      resolved?: string;
    };
    const tried = Array.isArray(props.failedApproaches)
      ? props.failedApproaches.map((x) => String(x)).filter(Boolean)
      : [];
    return (
      <div className="mt-2 space-y-1.5 text-sm">
        {typeof props.problem === "string" && (
          <p className="text-neutral-300">
            <span className="text-neutral-500">Problem: </span>
            {props.problem}
          </p>
        )}
        {tried.length > 0 && (
          <p className="text-neutral-400">
            <span className="text-neutral-500">Tried: </span>
            <span className="text-neutral-400">{tried.join(" · ")}</span>
          </p>
        )}
        {typeof props.workingSolution === "string" && (
          <p className="flex items-start gap-1.5 text-orange-300">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{props.workingSolution}</span>
          </p>
        )}
        {typeof props.resolved === "string" && (
          <p className="text-[11px] text-neutral-500">
            Resolved {props.resolved}
          </p>
        )}
      </div>
    );
  }

  // Default: compact key=value chips so dense graphs stay scannable.
  const entries = Object.entries(entity.properties).filter(
    ([, v]) => v != null && v !== "",
  );
  if (entries.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="rounded border border-neutral-800 bg-neutral-900/40 px-1.5 py-0.5 text-neutral-300"
        >
          <span className="text-neutral-500">{k}:</span>{" "}
          <span>{formatValue(v)}</span>
        </span>
      ))}
    </div>
  );
}

function EditRow({
  entity,
  onCancel,
  onSave,
}: {
  entity: Entity;
  onCancel: () => void;
  onSave: (patch: Partial<Entity>) => void | Promise<void>;
}) {
  const [name, setName] = useState(entity.name);
  // Properties are edited as JSON for now — the structured editor
  // would be a much bigger lift and the user is the only operator
  // here. JSON is honest about the underlying shape and validates
  // before save. If parse fails, we surface an inline error.
  const [propsText, setPropsText] = useState(
    JSON.stringify(entity.properties, null, 2),
  );
  const [confidence, setConfidence] = useState<Confidence>(entity.confidence);
  const [propError, setPropError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px]">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-600"
        />
        <select
          value={confidence}
          onChange={(e) => setConfidence(e.target.value as Confidence)}
          className="rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-600"
        >
          <option value="explicit">explicit</option>
          <option value="inferred">inferred</option>
          <option value="corrected">corrected</option>
        </select>
      </div>
      <textarea
        value={propsText}
        onChange={(e) => {
          setPropsText(e.target.value);
          setPropError(null);
        }}
        rows={Math.min(10, Math.max(3, propsText.split("\n").length))}
        className="block w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 font-mono text-xs text-neutral-100 outline-none focus:border-neutral-600"
        placeholder='{ "key": "value" }'
        spellCheck={false}
      />
      {propError && <p className="text-xs text-red-300">{propError}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            let parsed: Record<string, unknown> = {};
            const trimmed = propsText.trim();
            if (trimmed) {
              try {
                const v = JSON.parse(trimmed);
                if (!v || typeof v !== "object" || Array.isArray(v)) {
                  setPropError("properties must be a JSON object");
                  return;
                }
                parsed = v as Record<string, unknown>;
              } catch (err) {
                setPropError(
                  err instanceof Error ? err.message : "invalid JSON",
                );
                return;
              }
            }
            void onSave({
              name,
              properties: parsed,
              confidence,
              // replaceProperties — manual edits are authoritative;
              // user expects what they typed to BE the new shape.
              ...({ replaceProperties: true } as Partial<Entity>),
            });
          }}
          className="flex items-center gap-1.5 rounded-md border border-orange-800 bg-orange-900/40 px-3 py-1.5 text-sm text-orange-200 transition hover:bg-orange-900/60"
        >
          <Save className="h-3.5 w-3.5" />
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-md border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-neutral-900"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] ${CONFIDENCE_TONE[confidence]}`}
      title={`Confidence: ${confidence}`}
    >
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "string") {
    return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  }
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
  }
  if (typeof v === "object" && v != null) return JSON.stringify(v);
  return String(v);
}

function humanAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
