"use client";

import "@xyflow/react/dist/style.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

// ---------- API shapes -------------------------------------------------------

type NodeKind =
  | "project"
  | "person"
  | "tech"
  | "blocker"
  | "decision"
  | "milestone";
const NODE_KINDS: NodeKind[] = [
  "project",
  "person",
  "tech",
  "blocker",
  "decision",
  "milestone",
];

type GraphNode = {
  id: string;
  type: NodeKind;
  label: string;
  status: string | null;
  notes: string | null;
  hasClaudeMd: boolean;
};
type GraphEdge = {
  id: number;
  source: string;
  target: string;
  label: string | null;
};
type GraphPayload = { nodes: GraphNode[]; edges: GraphEdge[] };

type NodeDetail = GraphNode & { claudeMd: string | null };

// ---------- xyflow-shaped types ---------------------------------------------

type NodeData = {
  label: string;
  status: string | null;
  kind: NodeKind;
  hasClaudeMd: boolean;
  [k: string]: unknown;
};
type BrainNodeT = Node<NodeData>;

type EdgeData = {
  onDelete: (id: number) => void;
  [k: string]: unknown;
};
type BrainEdgeT = Edge<EdgeData>;

// ---------- Layout -----------------------------------------------------------

// Layered top-down layout keyed on node type. Deterministic and good enough
// for a few dozen nodes; swap for dagre/elk if the graph ever grows larger.
const LAYER_Y: Record<NodeKind, number> = {
  person: 0,
  decision: 110,
  project: 220,
  blocker: 330,
  milestone: 440,
  tech: 550,
};
const H_SPACING = 220;

function layout(nodes: GraphNode[]): BrainNodeT[] {
  const groups = new Map<NodeKind, GraphNode[]>();
  for (const n of nodes) {
    const arr = groups.get(n.type) ?? [];
    arr.push(n);
    groups.set(n.type, arr);
  }
  const result: BrainNodeT[] = [];
  for (const [kind, group] of groups) {
    const offset = ((group.length - 1) * H_SPACING) / 2;
    group.forEach((n, i) => {
      result.push({
        id: n.id,
        type: n.type,
        position: { x: i * H_SPACING - offset, y: LAYER_Y[kind] },
        data: {
          label: n.label,
          status: n.status,
          kind: n.type,
          hasClaudeMd: n.hasClaudeMd,
        },
      });
    });
  }
  return result;
}

function nextPositionFor(
  kind: NodeKind,
  existing: BrainNodeT[],
): { x: number; y: number } {
  const sameKind = existing.filter((n) => n.data.kind === kind);
  if (sameKind.length === 0) return { x: 0, y: LAYER_Y[kind] };
  const rightmost = Math.max(...sameKind.map((n) => n.position.x));
  return { x: rightmost + H_SPACING, y: LAYER_Y[kind] };
}

function toRfEdge(
  e: GraphEdge,
  onDelete: (id: number) => void,
): BrainEdgeT {
  return {
    id: String(e.id),
    source: e.source,
    target: e.target,
    label: e.label ?? undefined,
    type: "editable",
    data: { onDelete },
  };
}

// ---------- Roadmap parser ---------------------------------------------------

type RoadmapItem = { text: string; done: boolean };
type RoadmapGroup = { heading: string; items: RoadmapItem[] };

// Pulls `- [ ]` / `- [x]` checklist items out of CLAUDE.md and groups them by
// the nearest preceding `##` / `###` heading. Headings with no checklist
// items underneath are dropped.
function parseRoadmap(md: string): RoadmapGroup[] {
  const groups: RoadmapGroup[] = [];
  let currentHeading = "Tasks";
  for (const raw of md.split("\n")) {
    const headingMatch = raw.match(/^#{2,3}\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      currentHeading = headingMatch[1].trim();
      continue;
    }
    const taskMatch = raw.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      const done = taskMatch[1].toLowerCase() === "x";
      const text = taskMatch[2].trim();
      let group = groups.find((g) => g.heading === currentHeading);
      if (!group) {
        group = { heading: currentHeading, items: [] };
        groups.push(group);
      }
      group.items.push({ text, done });
    }
  }
  return groups;
}

// ---------- Custom node components ------------------------------------------

const HANDLE_CLS = "!border-none !h-1.5 !w-1.5";

function ProjectNode({ data }: { data: NodeData }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className={`!bg-indigo-500 ${HANDLE_CLS}`} />
      <div className="min-w-[160px] rounded-lg border-2 border-indigo-500/80 bg-neutral-900 px-4 py-2 text-center shadow">
        <div className="text-sm font-medium text-neutral-100">{data.label}</div>
        {data.status && (
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-indigo-300/80">
            {data.status}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className={`!bg-indigo-500 ${HANDLE_CLS}`} />
    </>
  );
}

function PersonNode({ data }: { data: NodeData }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className={`!bg-orange-500 ${HANDLE_CLS}`} />
      <div className="flex h-24 w-24 items-center justify-center rounded-full border-2 border-orange-500/80 bg-neutral-900 text-center text-sm font-medium text-neutral-100 shadow">
        {data.label}
      </div>
      <Handle type="source" position={Position.Bottom} className={`!bg-orange-500 ${HANDLE_CLS}`} />
    </>
  );
}

const HEX_CLIP =
  "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)";

function TechNode({ data }: { data: NodeData }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className={`!bg-amber-500 ${HANDLE_CLS}`} />
      <div className="relative h-20 w-40">
        <div className="absolute inset-0 bg-amber-500" style={{ clipPath: HEX_CLIP }} />
        <div className="absolute inset-[2px] bg-neutral-900" style={{ clipPath: HEX_CLIP }} />
        <div className="relative flex h-full items-center justify-center px-6 text-center text-xs font-medium text-neutral-100">
          {data.label}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className={`!bg-amber-500 ${HANDLE_CLS}`} />
    </>
  );
}

function BlockerNode({ data }: { data: NodeData }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className={`!bg-red-500 ${HANDLE_CLS}`} />
      <div className="min-w-[140px] rounded-md border-2 border-red-500/80 bg-neutral-900 px-3 py-2 text-center shadow">
        <div className="text-xs font-semibold uppercase tracking-wider text-red-300/80">
          Blocker
        </div>
        <div className="mt-0.5 text-sm text-neutral-100">{data.label}</div>
      </div>
      <Handle type="source" position={Position.Bottom} className={`!bg-red-500 ${HANDLE_CLS}`} />
    </>
  );
}

function DecisionNode({ data }: { data: NodeData }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className={`!bg-violet-500 ${HANDLE_CLS}`} />
      <div className="relative h-24 w-44 rotate-45 border-2 border-violet-500/80 bg-neutral-900">
        <div className="-rotate-45 flex h-full w-full items-center justify-center px-3 text-center text-xs font-medium text-neutral-100">
          {data.label}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className={`!bg-violet-500 ${HANDLE_CLS}`} />
    </>
  );
}

function MilestoneNode({ data }: { data: NodeData }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className={`!bg-cyan-500 ${HANDLE_CLS}`} />
      <div className="min-w-[160px] rounded-md border-2 border-cyan-500/80 bg-neutral-900 px-3 py-2 text-center shadow">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300/80">
          Milestone{data.status ? ` · ${data.status}` : ""}
        </div>
        <div className="mt-0.5 text-sm text-neutral-100">{data.label}</div>
      </div>
      <Handle type="source" position={Position.Bottom} className={`!bg-cyan-500 ${HANDLE_CLS}`} />
    </>
  );
}

const NODE_TYPES: NodeTypes = {
  project: ProjectNode,
  person: PersonNode,
  tech: TechNode,
  blocker: BlockerNode,
  decision: DecisionNode,
  milestone: MilestoneNode,
};

// ---------- Custom edge with hover-to-delete --------------------------------

function EditableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  data,
}: EdgeProps<BrainEdgeT>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: "#525252" }} />
      <EdgeLabelRenderer>
        <div
          className="group absolute flex items-center gap-1 px-2 py-0.5 nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          {label && (
            <span className="rounded bg-neutral-900/90 px-1.5 py-0.5 text-[11px] text-neutral-400">
              {label}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              const numericId = Number(id);
              if (Number.isFinite(numericId)) data?.onDelete(numericId);
            }}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-500 opacity-0 transition hover:border-red-500 hover:text-red-400 group-hover:opacity-100"
            aria-label="Delete edge"
            title="Delete edge"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES: EdgeTypes = { editable: EditableEdge };

// ---------- Main component ---------------------------------------------------

const ACCENT: Record<NodeKind, { bar: string; text: string; border: string }> = {
  project: { bar: "bg-indigo-500", text: "text-indigo-300", border: "border-indigo-500/60" },
  person: { bar: "bg-orange-500", text: "text-orange-300", border: "border-orange-500/60" },
  tech: { bar: "bg-amber-500", text: "text-amber-300", border: "border-amber-500/60" },
  blocker: { bar: "bg-red-500", text: "text-red-300", border: "border-red-500/60" },
  decision: { bar: "bg-violet-500", text: "text-violet-300", border: "border-violet-500/60" },
  milestone: { bar: "bg-cyan-500", text: "text-cyan-300", border: "border-cyan-500/60" },
};

export default function BrainGraph() {
  const [nodes, setNodes, onNodesChange] = useNodesState<BrainNodeT>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<BrainEdgeT>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const nodesRef = useRef<BrainNodeT[]>([]);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // ---- Edge delete handler stays stable across renders so we don't have to
  //      re-build the entire edge list every time the graph changes.
  const deleteEdge = useCallback(
    async (id: number) => {
      if (!confirm("Delete this connection?")) return;
      const res = await fetch(`/api/graph/edges/${id}`, { method: "DELETE" });
      if (!res.ok) return;
      setEdges((prev) => prev.filter((e) => e.id !== String(id)));
    },
    [setEdges],
  );

  const deleteEdgeRef = useRef(deleteEdge);
  useEffect(() => {
    deleteEdgeRef.current = deleteEdge;
  }, [deleteEdge]);

  // Pulls the latest graph from /api/graph and rebuilds the canvas.
  // Used by the initial load AND by the live-refresh WebSocket subscription
  // below — sharing one path keeps the post-update state identical to the
  // first-load state (deterministic layout, same edge handler wiring).
  //
  // `mergePositions` keeps existing node positions when refetching so a
  // live update doesn't snap the canvas back to the deterministic layout
  // mid-interaction. New nodes still flow through `layout()`.
  const reloadGraph = useCallback(
    async (mergePositions: boolean): Promise<void> => {
      const res = await fetch("/api/graph", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as GraphPayload;
      const laid = layout(data.nodes);
      if (mergePositions) {
        const prevById = new Map(
          nodesRef.current.map((n) => [n.id, n.position] as const),
        );
        for (const n of laid) {
          const p = prevById.get(n.id);
          if (p) n.position = p;
        }
      }
      setNodes(laid);
      setEdges(
        data.edges.map((e) =>
          toRfEdge(e, (id) => deleteEdgeRef.current(id)),
        ),
      );
    },
    [setNodes, setEdges],
  );

  const reloadGraphRef = useRef(reloadGraph);
  useEffect(() => {
    reloadGraphRef.current = reloadGraph;
  }, [reloadGraph]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await reloadGraph(false);
        if (cancelled) return;
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // reloadGraph is stable across renders (refs only), so we deliberately
    // run this once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live refresh: subscribe to the dashboard sync bus and refetch the
  // graph whenever something pushes a `graph:changed` event. The spar
  // tool's write_graph is the primary producer (lib/spar-graph.ts mirrors
  // its JSON write into SQLite and fires the broadcast) but any future
  // server-side mutation that calls broadcastGraphChanged() will be
  // picked up the same way.
  //
  // Pattern matches ProjectsLiveRefresh (3s reconnect, ignore unparsable
  // frames). A trailing 250 ms debounce coalesces bursts of writes —
  // cheap on the brain side and avoids re-laying-out the canvas N times
  // when a single spar turn fires multiple write_graphs.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: number | null = null;
    let debounceTimer: number | null = null;

    function connect() {
      if (closed) return;
      try {
        ws = new WebSocket(`${proto}//${window.location.host}/api/sync`);
      } catch {
        reconnectTimer = window.setTimeout(connect, 3000);
        return;
      }
      ws.addEventListener("message", (e) => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(typeof e.data === "string" ? e.data : "");
        } catch {
          return;
        }
        if (msg.type !== "graph:changed") return;
        if (debounceTimer !== null) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          debounceTimer = null;
          void reloadGraphRef.current(true).catch((err) => {
            console.warn("[brain] live refresh failed:", err);
          });
        }, 250);
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, 3000);
      });
      ws.addEventListener("error", () => {
        // close fires after error — let the close handler reconnect.
      });
    }

    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    };
  }, []);

  // ---- Selection + detail fetch
  const onNodeClick = useCallback(
    async (_: React.MouseEvent, node: BrainNodeT) => {
      setSelected(node.id);
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/graph/nodes/${node.id}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as { node: NodeDetail };
          setDetail(data.node);
        } else {
          setDetail(null);
        }
      } finally {
        setDetailLoading(false);
      }
    },
    [],
  );

  const onPaneClick = useCallback(() => {
    setSelected(null);
    setDetail(null);
  }, []);

  // ---- Edge create on connect
  const onConnect = useCallback(
    async (params: Connection) => {
      if (!params.source || !params.target) return;
      if (params.source === params.target) return;
      const res = await fetch("/api/graph/edges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: params.source,
          target: params.target,
        }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { edge: GraphEdge };
      setEdges((prev) => [
        ...prev,
        toRfEdge(data.edge, (id) => deleteEdgeRef.current(id)),
      ]);
    },
    [setEdges],
  );

  // ---- Node mutations (via the side panel)
  const handlePatch = useCallback(
    async (
      id: string,
      patch: { label?: string; status?: string | null; notes?: string | null },
    ) => {
      const res = await fetch(`/api/graph/nodes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return false;
      // Refresh local node visual + side-panel detail.
      setNodes((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  label: patch.label ?? n.data.label,
                  status:
                    patch.status === undefined ? n.data.status : patch.status,
                },
              }
            : n,
        ),
      );
      setDetail((prev) =>
        prev && prev.id === id
          ? {
              ...prev,
              label: patch.label ?? prev.label,
              status: patch.status === undefined ? prev.status : patch.status,
              notes: patch.notes === undefined ? prev.notes : patch.notes,
            }
          : prev,
      );
      return true;
    },
    [setNodes],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this node? Connected edges will also be removed.")) {
        return;
      }
      const res = await fetch(`/api/graph/nodes/${id}`, { method: "DELETE" });
      if (!res.ok) return;
      setNodes((prev) => prev.filter((n) => n.id !== id));
      setEdges((prev) =>
        prev.filter((e) => e.source !== id && e.target !== id),
      );
      setSelected(null);
      setDetail(null);
    },
    [setNodes, setEdges],
  );

  const handleAdd = useCallback(
    async (input: {
      id: string;
      type: NodeKind;
      label: string;
      status: string;
    }) => {
      const res = await fetch("/api/graph/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: input.id,
          type: input.type,
          label: input.label,
          status: input.status || null,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        return j?.error ?? "create_failed";
      }
      const data = (await res.json()) as { node: GraphNode };
      const pos = nextPositionFor(data.node.type, nodesRef.current);
      setNodes((prev) => [
        ...prev,
        {
          id: data.node.id,
          type: data.node.type,
          position: pos,
          data: {
            label: data.node.label,
            status: data.node.status,
            kind: data.node.type,
            hasClaudeMd: data.node.hasClaudeMd,
          },
        },
      ]);
      return null;
    },
    [setNodes],
  );

  const handleRefreshClaudeMd = useCallback(async () => {
    const res = await fetch("/api/graph/refresh-claude-md", { method: "POST" });
    if (!res.ok) return;
    // If a project node is open, re-fetch its detail so the new content shows.
    if (selected && detail?.type === "project") {
      const r = await fetch(`/api/graph/nodes/${selected}`, {
        cache: "no-store",
      });
      if (r.ok) {
        const d = (await r.json()) as { node: NodeDetail };
        setDetail(d.node);
        setNodes((prev) =>
          prev.map((n) =>
            n.id === selected
              ? { ...n, data: { ...n.data, hasClaudeMd: d.node.claudeMd != null } }
              : n,
          ),
        );
      }
    }
  }, [selected, detail, setNodes]);

  return (
    <div className="relative h-full w-full bg-neutral-950">
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
          Loading graph…
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-red-400">
          Couldn&apos;t load the graph.{error ? ` (${error})` : ""}
        </div>
      )}
      {status === "ready" && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onConnect={onConnect}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#262626" gap={24} />
          <Controls className="!bg-neutral-900 !border-neutral-800" />
          <MiniMap
            nodeColor={(n) => {
              const kind = (n.data as NodeData | undefined)?.kind;
              if (kind === "project") return "#6366f1";
              if (kind === "person") return "#ff6b3d";
              if (kind === "tech") return "#f59e0b";
              if (kind === "blocker") return "#ef4444";
              if (kind === "decision") return "#8b5cf6";
              if (kind === "milestone") return "#06b6d4";
              return "#525252";
            }}
            maskColor="rgba(10, 10, 10, 0.7)"
            className="!bg-neutral-900 !border !border-neutral-800"
          />
        </ReactFlow>
      )}

      {/* Floating add-node button */}
      {status === "ready" && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="absolute bottom-4 right-4 flex h-12 w-12 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-200 shadow-lg transition hover:border-indigo-500 hover:text-indigo-300"
          aria-label="Add node"
          title="Add node"
        >
          <Plus className="h-5 w-5" />
        </button>
      )}

      {adding && (
        <AddNodeForm onClose={() => setAdding(false)} onSubmit={handleAdd} />
      )}

      <DetailPanel
        nodeId={selected}
        detail={detail}
        loading={detailLoading}
        onClose={() => {
          setSelected(null);
          setDetail(null);
        }}
        onPatch={handlePatch}
        onDelete={handleDelete}
        onRefreshClaudeMd={handleRefreshClaudeMd}
      />
    </div>
  );
}

// ---------- DetailPanel -----------------------------------------------------

function DetailPanel({
  nodeId,
  detail,
  loading,
  onClose,
  onPatch,
  onDelete,
  onRefreshClaudeMd,
}: {
  nodeId: string | null;
  detail: NodeDetail | null;
  loading: boolean;
  onClose: () => void;
  onPatch: (
    id: string,
    patch: { label?: string; status?: string | null; notes?: string | null },
  ) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onRefreshClaudeMd: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Reset drafts whenever we open a different node.
  useEffect(() => {
    if (detail) {
      setLabelDraft(detail.label);
      setStatusDraft(detail.status ?? "");
      setNotesDraft(detail.notes ?? "");
    }
    setEditing(false);
    setShowRaw(false);
  }, [detail?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = nodeId != null;
  const accent = detail ? ACCENT[detail.type] : ACCENT.project;

  const roadmap = useMemo(
    () => (detail?.claudeMd ? parseRoadmap(detail.claudeMd) : []),
    [detail?.claudeMd],
  );
  const roadmapStats = useMemo(() => {
    let total = 0;
    let done = 0;
    for (const g of roadmap) {
      total += g.items.length;
      done += g.items.filter((i) => i.done).length;
    }
    return { total, done };
  }, [roadmap]);

  return (
    <aside
      className={`pointer-events-none absolute right-4 top-4 bottom-4 w-96 max-w-[calc(100vw-2rem)] transition-all duration-200 ease-out ${
        open
          ? "translate-x-0 opacity-100"
          : "pointer-events-none translate-x-4 opacity-0"
      }`}
    >
      <div
        className={`pointer-events-auto flex h-full flex-col overflow-hidden rounded-lg border bg-neutral-950/95 shadow-xl backdrop-blur ${accent.border}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-neutral-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className={`text-[10px] uppercase tracking-wider ${accent.text}`}>
              {detail?.type ?? "…"}
            </div>
            {editing && detail ? (
              <input
                type="text"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-base font-semibold text-neutral-100 focus:border-neutral-500 focus:outline-none"
              />
            ) : (
              <h2 className="mt-0.5 truncate text-base font-semibold text-neutral-100">
                {detail?.label ?? "Loading…"}
              </h2>
            )}
          </div>
          <div className="flex items-center gap-1">
            {detail && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md p-1 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                aria-label="Edit"
                title="Edit"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
            {detail && (
              <button
                type="button"
                onClick={() => onDelete(detail.id)}
                className="rounded-md p-1 text-neutral-400 hover:bg-neutral-900 hover:text-red-400"
                aria-label="Delete"
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              aria-label="Close details"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 thin-scroll">
          {loading && !detail && (
            <div className="text-xs text-neutral-500">Loading…</div>
          )}

          {detail && (
            <>
              {/* Section A: status + notes */}
              <section className="mb-4">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                  Status
                </h3>
                {editing ? (
                  <input
                    type="text"
                    value={statusDraft}
                    onChange={(e) => setStatusDraft(e.target.value)}
                    placeholder="active, paused, shipped…"
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
                  />
                ) : detail.status ? (
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${accent.border} ${accent.text}`}
                  >
                    {detail.status}
                  </span>
                ) : (
                  <span className="text-xs text-neutral-500">—</span>
                )}

                <h3 className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                  Notes
                </h3>
                {editing ? (
                  <textarea
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    rows={3}
                    placeholder="Free-form notes about this node"
                    className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 focus:border-neutral-500 focus:outline-none"
                  />
                ) : detail.notes ? (
                  <p className="whitespace-pre-wrap text-xs text-neutral-300">
                    {detail.notes}
                  </p>
                ) : (
                  <span className="text-xs text-neutral-500">—</span>
                )}

                {editing && (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await onPatch(detail.id, {
                          label: labelDraft.trim() || detail.label,
                          status: statusDraft.trim() || null,
                          notes: notesDraft.trim() || null,
                        });
                        if (ok) setEditing(false);
                      }}
                      className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLabelDraft(detail.label);
                        setStatusDraft(detail.status ?? "");
                        setNotesDraft(detail.notes ?? "");
                        setEditing(false);
                      }}
                      className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </section>

              {/* Sections B + C only meaningful for project nodes */}
              {detail.type === "project" && (
                <>
                  <section className="mb-4 border-t border-neutral-800 pt-4">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                        Roadmap
                      </h3>
                      <button
                        type="button"
                        onClick={async () => {
                          setRefreshing(true);
                          await onRefreshClaudeMd();
                          setRefreshing(false);
                        }}
                        disabled={refreshing}
                        className="flex items-center gap-1 rounded p-1 text-[10px] text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
                        title="Re-read CLAUDE.md from disk"
                      >
                        <RefreshCw
                          className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                        />
                        refresh
                      </button>
                    </div>
                    <Roadmap
                      groups={roadmap}
                      stats={roadmapStats}
                      accentBar={accent.bar}
                      accentText={accent.text}
                    />
                  </section>

                  <section className="border-t border-neutral-800 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowRaw((v) => !v)}
                      className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
                    >
                      Full Instructions
                      {showRaw ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>
                    {showRaw && (
                      <pre className="thin-scroll mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-900/60 p-2 text-[11px] leading-snug text-neutral-300">
                        {detail.claudeMd ??
                          "No CLAUDE.md found for this project."}
                      </pre>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

// ---------- Roadmap renderer ------------------------------------------------

function Roadmap({
  groups,
  stats,
  accentBar,
  accentText,
}: {
  groups: RoadmapGroup[];
  stats: { total: number; done: number };
  accentBar: string;
  accentText: string;
}) {
  if (groups.length === 0) {
    return (
      <p className="text-xs text-neutral-500">No roadmap defined yet.</p>
    );
  }
  const overallPct =
    stats.total === 0 ? 0 : Math.round((stats.done / stats.total) * 100);

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex items-baseline justify-between text-[11px]">
          <span className={`font-semibold ${accentText}`}>
            {stats.done} / {stats.total} complete
          </span>
          <span className="text-neutral-500">{overallPct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full ${accentBar} transition-all`}
            style={{ width: `${overallPct}%` }}
          />
        </div>
      </div>

      {groups.map((g) => {
        const done = g.items.filter((i) => i.done).length;
        const pct =
          g.items.length === 0 ? 0 : Math.round((done / g.items.length) * 100);
        return (
          <div key={g.heading}>
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span className="font-medium text-neutral-300">{g.heading}</span>
              <span className="text-neutral-500">
                {done}/{g.items.length}
              </span>
            </div>
            <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className={`h-full ${accentBar} transition-all`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <ul className="space-y-1">
              {g.items.map((it, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-xs leading-snug"
                >
                  <span
                    className={`mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm border ${
                      it.done
                        ? `${accentBar} border-transparent text-neutral-950`
                        : "border-neutral-700 text-transparent"
                    }`}
                  >
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  </span>
                  <span
                    className={
                      it.done
                        ? "text-neutral-500 line-through"
                        : "text-neutral-300"
                    }
                  >
                    {it.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Add-node form ----------------------------------------------------

function AddNodeForm({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: {
    id: string;
    type: NodeKind;
    label: string;
    status: string;
  }) => Promise<string | null>;
}) {
  const [id, setId] = useState("");
  const [type, setType] = useState<NodeKind>("project");
  const [label, setLabel] = useState("");
  const [statusVal, setStatusVal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(e: FormEvent) {
    e.preventDefault();
    if (!id.trim() || !label.trim()) {
      setError("id and label are required");
      return;
    }
    setSubmitting(true);
    setError(null);
    const err = await onSubmit({
      id: id.trim(),
      type,
      label: label.trim(),
      status: statusVal.trim(),
    });
    setSubmitting(false);
    if (err) {
      setError(err);
    } else {
      onClose();
    }
  }

  return (
    <div
      className="absolute inset-0 z-10 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handle}
        className="w-full max-w-sm rounded-t-lg border border-neutral-800 bg-neutral-950 p-4 shadow-xl sm:rounded-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-100">Add node</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="ID">
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="kebab-id"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
              autoFocus
            />
          </Field>
          <Field label="Type">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as NodeKind)}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            >
              {NODE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Display name"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </Field>
          <Field label="Status (optional)">
            <input
              type="text"
              value={statusVal}
              onChange={(e) => setStatusVal(e.target.value)}
              placeholder="active, paused, shipped…"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </Field>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded border border-red-900/60 bg-red-950/40 px-2 py-1 text-xs text-red-300">
            <Circle className="mt-0.5 h-2 w-2 fill-current" />
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  );
}
