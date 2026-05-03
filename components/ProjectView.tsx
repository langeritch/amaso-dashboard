"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder as FolderIcon } from "lucide-react";
import FileTree, { type TreeNode, type Selection } from "./FileTree";
import FileViewer from "./FileViewer";
import RemarksPanel, { type Remark } from "./RemarksPanel";
import RecentPanel from "./RecentPanel";
import PreviewPane from "./PreviewPane";
import DeployButton, { type GitStatusDto } from "./DeployButton";
import TerminalPane from "./TerminalPane";
import RoadmapPanel from "./RoadmapPanel";

type WsStatus = "connecting" | "open" | "closed" | "unreachable";
// "remarks" is a mobile-only pseudo-tab that promotes the side panel into
// the main view. On desktop (lg+) the remarks panel is always visible as a
// right column, so this tab is hidden there.
type Tab = "files" | "recent" | "preview" | "terminal" | "remarks" | "roadmap";
type RemarkScope = "item" | "project";

interface Me {
  id: number;
  name: string;
  role: "admin" | "team" | "client";
}

const RECENT_HISTORY_MAX = 6;

// WebSocket reconnect backoff so a laptop wake-from-sleep doesn't
// hammer the server with a tight retry loop, and a server that's
// actually down stops trying after the budget is exhausted instead of
// pinging forever.
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

export default function ProjectView({
  projectId,
  previewUrl,
  liveUrl,
  user,
}: {
  projectId: string;
  previewUrl?: string;
  liveUrl?: string;
  user: Me;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [recentSelections, setRecentSelections] = useState<Selection[]>([]);
  const [status, setStatus] = useState<WsStatus>("connecting");
  // Admins land on Terminal by default — everyone else on Files, since
  // Terminal is admin-only.
  const [tab, setTab] = useState<Tab>(user.role === "admin" ? "terminal" : "files");
  const [remarkScope, setRemarkScope] = useState<RemarkScope>("project");
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  // User is known from the server render — no need to wait for WS hello.
  // (We still update via WS hello in case role/name changed mid-session.)
  const [me, setMe] = useState<Me>(user);
  const [historyBump, setHistoryBump] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [screenshotQueue, setScreenshotQueue] = useState<File[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatusDto | null>(null);
  // Separate from `fullscreen` (preview). When on, the terminal is rendered
  // in a fixed overlay so the Topbar / project header / tab bar get covered,
  // giving Claude's TUI every pixel on mobile.
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  // Counts consecutive failed connect attempts. Reset to 0 once the
  // socket actually opens; consulted by the close handler to pick the
  // next backoff delay and to give up after MAX_RECONNECT_ATTEMPTS.
  const reconnectAttemptRef = useRef(0);
  const refreshTimer = useRef<number | null>(null);

  /** Unified selection setter: updates current + pushes to recent history. */
  const pickSelection = useCallback((sel: Selection | null) => {
    setSelected(sel);
    if (!sel) return;
    setRecentSelections((prev) => {
      const without = prev.filter(
        (p) => !(p.path === sel.path && p.type === sel.type),
      );
      return [sel, ...without].slice(0, RECENT_HISTORY_MAX);
    });
    // Auto-scope remarks to the item you just picked
    setRemarkScope("item");
  }, []);

  /**
   * Nuxt's inspector gives us absolute paths (e.g.
   * `C:/Users/santi/projects/neva17/pages/index.vue`). We need project-
   * relative to match what's in our tree. Strategy: find the last occurrence
   * of a "known-in-tree" path segment, then verify it.
   */
  const normalizeInspectorPath = useCallback(
    (rawPath: string): string | null => {
      // Vite's inspector sometimes hands us an absolute path
      // (`C:/.../neva17/pages/index.vue`) and sometimes a project-relative one
      // (`pages/index.vue`). Handle both.
      let norm = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
      // Strip a `file://` URI prefix if present
      norm = norm.replace(/^file:\/+/, "");

      const flat: string[] = [];
      const walk = (nodes: TreeNode[]) => {
        for (const n of nodes) {
          if (n.type === "file") flat.push(n.path);
          if (n.children) walk(n.children);
        }
      };
      walk(tree);

      const lowerNorm = norm.toLowerCase();
      // 1. Exact relative match — the common case for Nuxt's inspector
      for (const p of flat) {
        if (p === norm || p.toLowerCase() === lowerNorm) return p;
      }
      // 2. Absolute path that ends with a tree path
      for (const p of flat) {
        const needle = "/" + p;
        if (
          norm.endsWith(needle) ||
          lowerNorm.endsWith(needle.toLowerCase())
        ) {
          return p;
        }
      }
      // 3. Marker-based slice: find a well-known project dir in the path and
      //    cut from there. Works for absolute paths we don't exactly recognise.
      const markers = [
        "pages/",
        "components/",
        "layouts/",
        "composables/",
        "plugins/",
        "middleware/",
        "assets/",
        "server/",
        "utils/",
        "stores/",
        "public/",
      ];
      for (const m of markers) {
        // Prefer a `/marker/` hit (deeper in the path) over a start-of-string one
        const idx = lowerNorm.lastIndexOf("/" + m);
        if (idx >= 0) return norm.slice(idx + 1);
        if (lowerNorm.startsWith(m)) return norm;
      }
      // 4. Root-level file: exact basename match
      const last = norm.split("/").pop();
      if (last && flat.some((p) => p === last)) return last;
      return null;
    },
    [tree],
  );

  // Captured context + column from the most recent Alt+click in Preview.
  // Cleared after the next remark is posted so it only tags the next message.
  const [pendingContext, setPendingContext] = useState<{
    column: number;
    context: Record<string, unknown>;
    path: string;
    line: number;
  } | null>(null);

  const [inspectorWarning, setInspectorWarning] = useState<string | null>(null);

  const handleInspectorPick = useCallback(
    (pick: {
      path: string;
      line: number;
      col: number;
      context?: Record<string, unknown>;
    }) => {
      const rel = normalizeInspectorPath(pick.path);
      if (!rel) {
        // Surface a visible warning — silent failures are the worst
        console.warn("[amaso] inspector pick: couldn't map to project file", pick);
        setInspectorWarning(
          `Couldn't map element path to a tree file: ${pick.path}`,
        );
        window.setTimeout(() => setInspectorWarning(null), 5000);
        return;
      }
      setInspectorWarning(null);
      // 1. Highlight the file in the sidebar + set it as remark target.
      //    Does NOT switch tabs — the user stays in Preview so their flow
      //    isn't interrupted. The file only opens in Monaco when they click
      //    it in the tree themselves (or use the ↗ jump button on a remark).
      pickSelection({ path: rel, type: "file" });
      // 2. Remember the line (so if they later click the file in the tree,
      //    Monaco scrolls to it) AND so the remark gets tagged with it.
      setPendingLine(pick.line);
      // 3. Save rich element context for the next remark
      if (pick.context) {
        setPendingContext({
          column: pick.col,
          context: pick.context,
          path: rel,
          line: pick.line,
        });
      }
      // NOTE: intentionally NOT setting tab → preview stays front-and-centre.
    },
    [normalizeInspectorPath, pickSelection],
  );

  /**
   * Polling fetches should swallow network errors — they fire every few
   * seconds and the server can be briefly unreachable during Next.js dev
   * restarts or HMR rebuilds. An unhandled rejection shows up as a scary
   * red error in the user's browser console for no real reason.
   */
  async function safeJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  const loadTree = useCallback(async () => {
    const data = await safeJson<{ tree: TreeNode[]; truncated?: boolean }>(
      `/api/projects/${projectId}/tree`,
    );
    if (!data) return;
    setTree(data.tree);
    setTruncated(Boolean(data.truncated));
  }, [projectId]);

  const loadGit = useCallback(async () => {
    const data = await safeJson<GitStatusDto>(
      `/api/projects/${projectId}/git`,
    );
    if (data) setGitStatus(data);
  }, [projectId]);

  // Single unified feed — always fetch everything for this project. The
  // panel itself handles filtering, highlighting the remarks relevant to the
  // current selection.
  const loadRemarks = useCallback(async () => {
    const data = await safeJson<{ remarks: Remark[] }>(
      `/api/projects/${projectId}/remarks`,
    );
    if (data) setRemarks(data.remarks);
  }, [projectId]);

  // remarkScope still tracks what the *next* remark targets (item vs project)
  // but the displayed list is always the full project feed.

  const [fileRemarksForGutter, setFileRemarksForGutter] = useState<Remark[]>(
    [],
  );
  const loadFileRemarks = useCallback(async () => {
    if (!selected || selected.type !== "file") {
      setFileRemarksForGutter([]);
      return;
    }
    const data = await safeJson<{ remarks: Remark[] }>(
      `/api/projects/${projectId}/remarks?path=${encodeURIComponent(selected.path)}`,
    );
    if (data) setFileRemarksForGutter(data.remarks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selected]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);
  useEffect(() => {
    void loadRemarks();
  }, [loadRemarks]);
  useEffect(() => {
    void loadFileRemarks();
  }, [loadFileRemarks]);
  useEffect(() => {
    void loadGit();
  }, [loadGit]);

  useEffect(() => {
    const iv = window.setInterval(() => void loadGit(), 15_000);
    return () => window.clearInterval(iv);
  }, [loadGit]);

  useEffect(() => {
    let closed = false;
    function connect() {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/api/sync`);
      wsRef.current = ws;
      setStatus("connecting");
      ws.addEventListener("open", () => {
        setStatus("open");
        // Connection established — clear the backoff counter so a
        // later disconnect starts fresh from the shortest delay.
        reconnectAttemptRef.current = 0;
        ws.send(JSON.stringify({ type: "subscribe", projectId }));
      });
      ws.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "hello") setMe(msg.user);
          else if (msg.type === "file") {
            if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
            refreshTimer.current = window.setTimeout(() => {
              void loadTree();
              void loadGit();
            }, 300);
          } else if (msg.type === "history") {
            setHistoryBump((n) => n + 1);
          } else if (msg.type === "remark") {
            void loadRemarks();
            if (selected?.type === "file" && msg.path === selected.path) {
              void loadFileRemarks();
            }
          }
        } catch {
          /* ignore */
        }
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        const attempt = reconnectAttemptRef.current;
        // Budget exhausted → mark unreachable and stop retrying. The
        // user can navigate away/back to retry from scratch. Without
        // this cap a server actually down would be hammered forever.
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          setStatus("unreachable");
          console.warn(
            `[ProjectView] /api/sync unreachable after ${MAX_RECONNECT_ATTEMPTS} attempts`,
          );
          return;
        }
        const delay =
          RECONNECT_DELAYS_MS[
            Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)
          ];
        reconnectAttemptRef.current = attempt + 1;
        setStatus("closed");
        reconnectRef.current = window.setTimeout(connect, delay);
      });
      ws.addEventListener("error", () => ws.close());
    }
    connect();
    return () => {
      closed = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      wsRef.current?.close();
    };
  }, [projectId, loadTree, loadRemarks, loadFileRemarks, loadGit, selected]);

  useEffect(() => {
    if (fullscreen) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [fullscreen]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && fullscreen) setFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const hasPreview = Boolean(previewUrl || liveUrl);
  const canManageDev = me?.role === "admin";

  function queueScreenshot(file: File) {
    setScreenshotQueue((q) => [...q, file].slice(-10));
  }

  const modifiedSet = gitStatus
    ? new Set(gitStatus.modified.concat(gitStatus.staged))
    : undefined;
  const untrackedSet = gitStatus ? new Set(gitStatus.untracked) : undefined;

  if (fullscreen && hasPreview) {
    return (
      <div className="fixed inset-0 z-50 bg-black">
        <PreviewPane
          projectId={projectId}
          testUrl={previewUrl ?? null}
          liveUrl={liveUrl ?? null}
          fullscreen
          onToggleFullscreen={() => setFullscreen(false)}
          onScreenshot={queueScreenshot}
          queuedCount={screenshotQueue.length}
          canManageDev={canManageDev}
          onInspectorPick={handleInspectorPick}
        />
      </div>
    );
  }

  if (terminalFullscreen && me.role === "admin") {
    return (
      <div className="fixed inset-0 z-50 bg-neutral-950">
        <TerminalPane
          projectId={projectId}
          canManage
          fullscreen
          onToggleFullscreen={() => setTerminalFullscreen(false)}
        />
      </div>
    );
  }

  // Central content area changes depending on the tab; tree + remarks are
  // shared between Files and Preview so the user can leave file-scoped
  // remarks while looking at the rendered site.
  let centre: React.ReactNode = null;
  if (tab === "files") {
    centre =
      selected?.type === "file" ? (
        <FileViewer
          projectId={projectId}
          path={selected.path}
          remarks={fileRemarksForGutter}
          scrollToLine={pendingLine}
          onGutterClick={(line) => {
            setRemarkScope("item");
            setPendingLine(line);
          }}
        />
      ) : selected?.type === "dir" ? (
        <FolderPlaceholder path={selected.path} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-neutral-500">
          Select a file or folder — or leave a project-level remark on the right.
        </div>
      );
  } else if (tab === "terminal") {
    centre = (
      <TerminalPane
        projectId={projectId}
        canManage={me.role === "admin"}
        onToggleFullscreen={() => setTerminalFullscreen(true)}
      />
    );
  } else if (tab === "preview") {
    centre = (
      <PreviewPane
        projectId={projectId}
        testUrl={previewUrl ?? null}
        liveUrl={liveUrl ?? null}
        fullscreen={false}
        onToggleFullscreen={() => setFullscreen(true)}
        onScreenshot={queueScreenshot}
        queuedCount={screenshotQueue.length}
        canManageDev={canManageDev}
        onInspectorPick={handleInspectorPick}
      />
    );
  } else if (tab === "roadmap") {
    centre = <RoadmapPanel projectId={projectId} />;
  }

  const remarksPanelProps = {
    projectId,
    selected,
    recentSelections,
    onPickRecent: pickSelection,
    remarks,
    currentUserId: me.id,
    currentUserRole: me.role,
    pendingLine,
    onPendingLineCleared: () => setPendingLine(null),
    pendingContext,
    onContextCleared: () => setPendingContext(null),
    onChanged: () => {
      void loadRemarks();
      void loadFileRemarks();
    },
    scope: remarkScope,
    onScopeChange: setRemarkScope,
    pendingScreenshots: screenshotQueue,
    onScreenshotsConsumed: () => setScreenshotQueue([]),
    onJumpToFile: (p: string, l: number | null) => {
      pickSelection({ path: p, type: "file" });
      setPendingLine(l ?? null);
      setTab("files");
    },
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Tab bar. On mobile: horizontal scroll so no tab is ever hidden,
          each tab has a 40px min tap target. Action buttons live on a
          separate row below (mobile) or inline (desktop). */}
      <div className="thin-scroll flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800 bg-neutral-950/60 px-2 py-1 text-xs sm:px-3 sm:py-1.5">
        {me.role === "admin" && (
          <TabBtn
            active={tab === "terminal"}
            onClick={() => setTab("terminal")}
          >
            <span className="sm:hidden">Term</span>
            <span className="hidden sm:inline">Terminal</span>
          </TabBtn>
        )}
        {hasPreview && (
          <TabBtn active={tab === "preview"} onClick={() => setTab("preview")}>
            <span className="sm:hidden">Prev</span>
            <span className="hidden sm:inline">Preview</span>
          </TabBtn>
        )}
        <TabBtn active={tab === "files"} onClick={() => setTab("files")}>
          Files
        </TabBtn>
        <TabBtn active={tab === "roadmap"} onClick={() => setTab("roadmap")}>
          <span className="sm:hidden">Plan</span>
          <span className="hidden sm:inline">Roadmap</span>
        </TabBtn>
        {/* Mobile-only: Remarks as its own tab (right panel is hidden at <lg) */}
        <span className="lg:hidden">
          <TabBtn
            active={tab === "remarks"}
            onClick={() => setTab("remarks")}
          >
            <span className="sm:hidden">Notes</span>
            <span className="hidden sm:inline">Remarks</span>
            {remarks.filter((r) => !r.resolvedAt).length > 0 && (
              <span className="ml-1 rounded-full bg-amber-500 px-1 py-px text-[9px] font-medium text-black">
                {remarks.filter((r) => !r.resolvedAt).length}
              </span>
            )}
          </TabBtn>
        </span>
        <TabBtn active={tab === "recent"} onClick={() => setTab("recent")}>
          <span className="sm:hidden">Recent</span>
          <span className="hidden sm:inline">Recent changes</span>
        </TabBtn>
        {screenshotQueue.length > 0 && (
          <span
            className="ml-auto hidden flex-shrink-0 rounded-full bg-amber-600 px-2 py-0.5 text-[10px] font-medium text-black sm:inline-flex"
            title="Screenshots queued — they'll attach to your next remark"
          >
            {screenshotQueue.length}📸
          </span>
        )}
        {/* Target indicator — hidden on small screens to save space */}
        <span
          className={`ml-2 hidden flex-shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] md:flex ${
            selected
              ? "bg-orange-900/50 text-orange-200"
              : "bg-neutral-800 text-neutral-500"
          }`}
          title={
            selected
              ? "Next remark will target this"
              : "No file or folder selected — remarks will be project-level"
          }
        >
          {selected ? (
            <>
              <span>🎯</span>
              <span className="max-w-[16ch] truncate font-mono xl:max-w-none">
                {selected.path}
              </span>
              <button
                type="button"
                onClick={() => pickSelection(null)}
                className="ml-1 rounded px-1 text-orange-300 hover:bg-orange-800/50"
                title="Clear selection"
              >
                ×
              </button>
            </>
          ) : (
            <>🎯 project</>
          )}
        </span>
        {inspectorWarning && (
          <span
            className="ml-2 flex-shrink-0 rounded bg-red-900/60 px-2 py-0.5 text-[10px] text-red-200"
            title={inspectorWarning}
          >
            ⚠ inspector
          </span>
        )}
        {/* Desktop action group — on mobile these live in a second row below */}
        <div className="ml-auto hidden flex-shrink-0 items-center gap-2 sm:flex">
          <DeployButton
            projectId={projectId}
            status={gitStatus}
            onDone={() => {
              void loadGit();
              void loadTree();
            }}
            isAdmin={me?.role === "admin"}
          />
          <StatusDot status={status} />
        </div>
      </div>

      {/* Mobile-only action row — tucks the high-value buttons under the
          tab bar so they never get scrolled out of view. Hidden on the
          terminal tab: the terminal has its own status pill and all the
          vertical space we can spare is worth more than a Fix/Deploy
          shortcut that you'd never reach for mid-Claude-session. */}
      {me.role === "admin" && tab !== "terminal" && (
        <div className="flex items-center justify-end gap-2 border-b border-neutral-800 bg-neutral-950/40 px-3 py-1.5 sm:hidden">
          <StatusDot status={status} />
          <DeployButton
            projectId={projectId}
            status={gitStatus}
            onDone={() => {
              void loadGit();
              void loadTree();
            }}
            isAdmin={me?.role === "admin"}
          />
        </div>
      )}

      {tab === "recent" ? (
        <RecentPanel projectId={projectId} wsBump={historyBump} />
      ) : (
        /* Main layout:
           - Desktop (lg+): 3 cols — tree | centre | remarks
           - Mobile       : single column, panels promoted to their own tabs */
        <div className="flex flex-1 flex-col overflow-hidden lg:grid lg:grid-cols-[260px_1fr_360px]">
          {/* Tree column: always visible lg+, on mobile only on Files tab */}
          <aside
            className={`thin-scroll flex-col overflow-hidden border-neutral-800 bg-neutral-950/40 lg:flex lg:border-r ${
              tab === "files" ? "flex border-b" : "hidden"
            }`}
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
              <span>Files</span>
              {gitStatus?.branch && (
                <span
                  className="flex items-center gap-1 font-mono text-[10px] text-neutral-500"
                  title={`${gitStatus.ahead} ahead, ${gitStatus.behind} behind origin/${gitStatus.branch}`}
                >
                  ⎇ {gitStatus.branch}
                </span>
              )}
            </div>
            <div className="thin-scroll max-h-[40vh] flex-1 overflow-auto p-2 lg:max-h-none">
              <FileTree
                nodes={tree}
                selected={selected}
                onSelect={pickSelection}
                modifiedPaths={modifiedSet}
                untrackedPaths={untrackedSet}
              />
              {truncated && (
                <p className="mt-3 text-xs text-amber-400/80">
                  Tree truncated — project exceeds the listing limit.
                </p>
              )}
            </div>
          </aside>

          {/* Centre — hidden on mobile when remarks tab is active.
           * `flex-1 min-h-0` is the crucial bit on mobile: without it
           * this section collapses to content height and TerminalPane's
           * `h-full` has nothing to resolve against, so the terminal
           * ends two-thirds down the screen with empty space under it.
           * On desktop the parent switches to `lg:grid` and these
           * classes are no-ops — the column track drives the size. */}
          <section
            className={`flex min-h-0 flex-1 flex-col overflow-hidden ${
              tab === "remarks" ? "hidden lg:block" : "block"
            }`}
          >
            {centre}
          </section>

          {/* Remarks column: always visible lg+, on mobile only when tab === remarks.
           * `min-h-0` is what lets the inner panel's scroll region collapse to
           * the available space on mobile — without it the column grows to fit
           * its content and the input form gets pushed below the viewport. */}
          <div
            className={`min-h-0 border-neutral-800 lg:flex lg:flex-col ${
              tab === "remarks" ? "flex flex-1 flex-col" : "hidden"
            }`}
          >
            <RemarksPanel {...remarksPanelProps} />
          </div>
        </div>
      )}
    </div>
  );
}

function FolderPlaceholder({ path }: { path: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-400">
      <FolderIcon className="h-10 w-10 text-sky-400/70" />
      <div className="text-center">
        <div className="font-mono text-sm">{path || "/"}</div>
        <div className="mt-1 text-xs text-neutral-500">
          Folder selected. Leave a remark on the right, or pick a file to view it.
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`amaso-fx flex min-h-[36px] flex-shrink-0 items-center whitespace-nowrap rounded-md px-3 sm:min-h-0 sm:px-2.5 sm:py-1 ${
        active
          ? "bg-neutral-800/90 text-neutral-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
          : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-100"
      }`}
    >
      {children}
    </button>
  );
}

function StatusDot({ status }: { status: WsStatus }) {
  const colour =
    status === "open"
      ? "bg-orange-500"
      : status === "connecting"
        ? "bg-amber-500"
        : status === "unreachable"
          ? "bg-red-700"
          : "bg-red-500";
  const label =
    status === "open"
      ? "live"
      : status === "connecting"
        ? "connecting"
        : status === "unreachable"
          ? "unreachable"
          : "offline";
  return (
    <span className="flex items-center gap-1.5 text-neutral-400">
      <span className={`inline-block h-2 w-2 rounded-full ${colour}`} />
      <span>{label}</span>
    </span>
  );
}
