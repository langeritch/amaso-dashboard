"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Trash2,
  Paperclip,
  X,
  Image as ImageIcon,
  Sparkles,
  File as FileIcon,
  Folder as FolderIcon,
  MousePointerClick,
  ExternalLink,
  Check,
  Circle,
} from "lucide-react";
import { inferCategory } from "@/lib/categoryInference";
import type { Selection } from "./FileTree";

export type Category = "frontend" | "backend" | "other";

export interface Attachment {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
}

export interface RemarkContext {
  tag?: string;
  id?: string | null;
  classes?: string[];
  attrs?: Record<string, string>;
  text?: string;
  outerHtml?: string;
  locator?: string;
  pageUrl?: string;
}

export interface Remark {
  id: number;
  userId: number;
  userName: string;
  path: string | null;
  line: number | null;
  column?: number | null;
  context?: RemarkContext | null;
  category: Category;
  body: string;
  createdAt: number;
  /** Timestamp when Claude (or an admin) marked this done. */
  resolvedAt?: number | null;
  attachments: Attachment[];
}

type Scope = "item" | "project";

export default function RemarksPanel({
  projectId,
  selected,
  recentSelections = [],
  onPickRecent,
  remarks,
  currentUserId,
  currentUserRole,
  pendingLine,
  onPendingLineCleared,
  onChanged,
  scope,
  onScopeChange,
  pendingScreenshots,
  onScreenshotsConsumed,
  pendingContext,
  onContextCleared,
  onJumpToFile,
}: {
  projectId: string;
  selected: Selection | null;
  recentSelections?: Selection[];
  onPickRecent?: (sel: Selection) => void;
  remarks: Remark[];
  currentUserId: number;
  currentUserRole: "admin" | "team" | "client";
  pendingLine: number | null;
  onPendingLineCleared: () => void;
  onChanged: () => void;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  pendingScreenshots?: File[];
  onScreenshotsConsumed?: () => void;
  /** Element context from the most recent Preview inspector pick. */
  pendingContext?: {
    column: number;
    context: Record<string, unknown>;
    path: string;
    line: number;
  } | null;
  onContextCleared?: () => void;
  /** Jump to a file+line in the dashboard's Monaco viewer. */
  onJumpToFile?: (path: string, line: number | null) => void;
}) {
  const [body, setBody] = useState("");
  const [line, setLine] = useState<number | null>(null);
  const [category, setCategory] = useState<Category>("frontend");
  const [userPickedCategory, setUserPickedCategory] = useState(false);
  const [target, setTarget] = useState<"item" | "project">(
    selected ? "item" : "project",
  );
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Category>("all");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isFile = selected?.type === "file";
  const isDir = selected?.type === "dir";

  // Smart inference, context = target + selected path + body
  const inference = useMemo(
    () =>
      inferCategory({
        path: target === "item" && selected ? selected.path : null,
        body,
        fallback: category,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target, selected?.path, body],
  );
  useEffect(() => {
    if (!userPickedCategory && inference.category !== category) {
      setCategory(inference.category);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inference.category, userPickedCategory]);

  function pickCategory(next: Category) {
    setCategory(next);
    setUserPickedCategory(true);
  }

  // When the tree selection changes, auto-point the new remark at it.
  // Also clear the manual category override so inference kicks back in.
  useEffect(() => {
    setUserPickedCategory(false);
    setTarget(selected ? "item" : "project");
  }, [selected?.path, selected?.type]);

  // Gutter click pins a line and forces item-target (only valid for files)
  useEffect(() => {
    if (pendingLine !== null) {
      setLine(pendingLine);
      setTarget("item");
      onPendingLineCleared();
    }
  }, [pendingLine, onPendingLineCleared]);

  // Absorb screenshots captured from the Preview tab into the attachment list
  useEffect(() => {
    if (!pendingScreenshots || pendingScreenshots.length === 0) return;
    setFiles((cur) => [...cur, ...pendingScreenshots].slice(0, 5));
    onScreenshotsConsumed?.();
  }, [pendingScreenshots, onScreenshotsConsumed]);

  // Mirror of the pendingContext as local state so the user can dismiss it
  // without losing the raw value in the parent.
  const [localContext, setLocalContext] = useState<typeof pendingContext>(null);
  useEffect(() => {
    if (pendingContext) setLocalContext(pendingContext);
  }, [pendingContext]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setPending(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("body", body.trim());
      fd.append("category", category);
      if (target === "item" && selected) {
        fd.append("path", selected.path);
        if (isFile && line !== null) fd.append("line", String(line));
      }
      // Attach element context if we have one matching the current target
      if (
        localContext &&
        target === "item" &&
        selected?.path === localContext.path &&
        line === localContext.line
      ) {
        fd.append("column", String(localContext.column));
        fd.append("context", JSON.stringify(localContext.context));
      }
      for (const f of files) fd.append("files", f, f.name);
      const res = await fetch(`/api/projects/${projectId}/remarks`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErr(prettyError(b.error));
        return;
      }
      setBody("");
      setLine(null);
      setFiles([]);
      setUserPickedCategory(false);
      setLocalContext(null);
      onContextCleared?.();
      onChanged();
    } finally {
      setPending(false);
    }
  }

  async function remove(id: number) {
    await fetch(`/api/projects/${projectId}/remarks/${id}`, {
      method: "DELETE",
    });
    onChanged();
  }

  function addFiles(list: FileList | File[]) {
    const added = Array.from(list);
    setFiles((cur) => [...cur, ...added].slice(0, 5));
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData.items;
    const imgs: File[] = [];
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          const renamed = new File(
            [f],
            `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
            { type: f.type },
          );
          imgs.push(renamed);
        }
      }
    }
    if (imgs.length) {
      e.preventDefault();
      addFiles(imgs);
    }
  }

  function onDrop(e: React.DragEvent<HTMLFormElement>) {
    e.preventDefault();
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  // Hide resolved by default — you can flip to see them again.
  const [showResolved, setShowResolved] = useState(false);
  const visibleByState = showResolved
    ? remarks
    : remarks.filter((r) => !r.resolvedAt);

  // Category filter
  const categoryFiltered =
    filter === "all"
      ? visibleByState
      : visibleByState.filter((r) => r.category === filter);

  // Optional "only show remarks related to the selected item" toggle
  const [onlySelected, setOnlySelected] = useState(false);
  useEffect(() => {
    // Reset the toggle whenever the selection changes
    setOnlySelected(false);
  }, [selected?.path, selected?.type]);

  /** Does a remark relate to what the user currently has selected in the tree? */
  function isRelatedToSelection(r: Remark): boolean {
    if (!selected) return false;
    if (!r.path) return false;
    if (selected.type === "file") return r.path === selected.path;
    // Folder selected: remark must be at that path or inside it
    return (
      r.path === selected.path || r.path.startsWith(selected.path + "/")
    );
  }

  const filteredRemarks = onlySelected
    ? categoryFiltered.filter(isRelatedToSelection)
    : categoryFiltered;

  const relatedCount = selected
    ? categoryFiltered.filter(isRelatedToSelection).length
    : 0;

  return (
    <div className="flex h-full flex-col border-l border-neutral-800 bg-neutral-950/40">
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-400">
            Remarks{remarks.length > 0 && ` · ${remarks.length}`}
          </span>
          {selected && relatedCount > 0 && (
            <button
              type="button"
              onClick={() => setOnlySelected((v) => !v)}
              className={`rounded-full border px-2 py-0.5 text-[10px] transition ${
                onlySelected
                  ? "border-emerald-700 bg-emerald-900/40 text-emerald-200"
                  : "border-neutral-700 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
              }`}
              title={
                onlySelected
                  ? "Show all project remarks"
                  : `Only show the ${relatedCount} remark${
                      relatedCount === 1 ? "" : "s"
                    } related to the selected ${selected.type}`
              }
            >
              {onlySelected
                ? "← show all"
                : `filter to selection (${relatedCount})`}
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </FilterChip>
          <FilterChip active={filter === "frontend"} onClick={() => setFilter("frontend")}>
            Frontend
          </FilterChip>
          <FilterChip active={filter === "backend"} onClick={() => setFilter("backend")}>
            Backend
          </FilterChip>
          <FilterChip active={filter === "other"} onClick={() => setFilter("other")}>
            Other
          </FilterChip>
          {remarks.some((r) => r.resolvedAt) && (
            <button
              type="button"
              onClick={() => setShowResolved((v) => !v)}
              className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] transition ${
                showResolved
                  ? "border-neutral-600 bg-neutral-800 text-white"
                  : "border-neutral-800 text-neutral-500 hover:border-neutral-700"
              }`}
              title={showResolved ? "Hide resolved remarks" : "Show resolved remarks"}
            >
              {showResolved ? "hide resolved" : `+${remarks.filter((r) => r.resolvedAt).length} resolved`}
            </button>
          )}
        </div>
      </div>

      <div className="thin-scroll flex-1 overflow-auto">
        {filteredRemarks.length === 0 ? (
          <Info>
            {remarks.length === 0
              ? "No remarks yet. Add the first one below."
              : onlySelected
                ? "No remarks for the current selection."
                : "No remarks match this filter."}
          </Info>
        ) : (
          <ul className="divide-y divide-neutral-900">
            {filteredRemarks.map((r) => (
              <RemarkItem
                key={r.id}
                projectId={projectId}
                remark={r}
                highlighted={isRelatedToSelection(r)}
                canDelete={
                  currentUserRole === "admin" || r.userId === currentUserId
                }
                canResolve={currentUserRole === "admin"}
                onDelete={() => remove(r.id)}
                onToggleResolved={async () => {
                  await fetch(
                    `/api/projects/${projectId}/remarks/${r.id}/resolve`,
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ resolved: !r.resolvedAt }),
                    },
                  );
                  onChanged();
                }}
                onJump={(p, l) =>
                  onJumpToFile && onJumpToFile(p, l ?? null)
                }
              />
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={submit}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="pb-safe pl-safe pr-safe space-y-2 border-t border-neutral-800 p-3"
      >
        {/* Prominent target banner — always visible, always obvious */}
        <div
          className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs ${
            target === "item" && selected
              ? "border-emerald-700/60 bg-emerald-900/20"
              : "border-neutral-800 bg-neutral-900"
          }`}
        >
          <span className="text-neutral-500">Target:</span>
          {target === "item" && selected ? (
            <>
              {isDir ? (
                <FolderIcon className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
              ) : (
                <FileIcon className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
              )}
              <span
                className="flex-1 truncate font-mono text-emerald-200"
                title={selected.path}
              >
                {selected.path}
              </span>
              <button
                type="button"
                onClick={() => setTarget("project")}
                className="rounded px-1.5 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800"
                title="Switch to project-level"
              >
                use project instead
              </button>
            </>
          ) : (
            <>
              <span className="flex-1 italic text-neutral-500">
                Whole project (no file/folder selected)
              </span>
              {selected && (
                <button
                  type="button"
                  onClick={() => setTarget("item")}
                  className="flex items-center gap-1 rounded bg-emerald-700 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-600"
                  title={`Use ${selected.path} as target`}
                >
                  use {selected.type === "dir" ? "folder" : "file"} →
                </button>
              )}
            </>
          )}
        </div>

        {/* Element context captured from Alt+Click in the Preview tab.
            Visible so the user knows extra AI-readable info will be saved
            with this remark. */}
        {localContext &&
          target === "item" &&
          selected &&
          selected.path === localContext.path && (
            <div className="rounded border border-emerald-800/50 bg-emerald-900/10 p-2 text-[11px]">
              <div className="flex items-center gap-1.5">
                <MousePointerClick className="h-3 w-3 text-emerald-400" />
                <span className="text-emerald-300">Element captured</span>
                <button
                  type="button"
                  onClick={() => {
                    setLocalContext(null);
                    onContextCleared?.();
                  }}
                  className="ml-auto rounded px-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  title="Don't attach this context"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <ContextPreview ctx={localContext.context as RemarkContext} />
              <p className="mt-1 text-[10px] text-neutral-500">
                Line {localContext.line}:{localContext.column} · saved with the remark
                so an AI can identify the exact element later.
              </p>
            </div>
          )}

        {target === "item" &&
          onPickRecent &&
          recentSelections.filter(
            (r) => !(selected && r.path === selected.path && r.type === selected.type),
          ).length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-neutral-500">Recent:</span>
              {recentSelections
                .filter(
                  (r) =>
                    !(selected && r.path === selected.path && r.type === selected.type),
                )
                .slice(0, 5)
                .map((r) => (
                  <button
                    key={`${r.type}:${r.path}`}
                    type="button"
                    onClick={() => onPickRecent(r)}
                    title={r.path}
                    className="flex items-center gap-1 rounded-full border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
                  >
                    {r.type === "dir" ? (
                      <FolderIcon className="h-2.5 w-2.5 text-sky-400/70" />
                    ) : (
                      <FileIcon className="h-2.5 w-2.5 text-neutral-500" />
                    )}
                    <span className="max-w-[120px] truncate">
                      {r.path.split("/").pop() || r.path}
                    </span>
                  </button>
                ))}
            </div>
          )}

        <div className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500">About:</span>
          <CatBtn
            active={category === "frontend"}
            onClick={() => pickCategory("frontend")}
            auto={!userPickedCategory && inference.category === "frontend" && inference.confident}
          >
            Frontend
          </CatBtn>
          <CatBtn
            active={category === "backend"}
            onClick={() => pickCategory("backend")}
            auto={!userPickedCategory && inference.category === "backend" && inference.confident}
          >
            Backend
          </CatBtn>
          <CatBtn
            active={category === "other"}
            onClick={() => pickCategory("other")}
            auto={!userPickedCategory && inference.category === "other" && inference.confident}
          >
            Other
          </CatBtn>
          {!userPickedCategory && inference.confident && (
            <span
              className="ml-1 flex items-center gap-0.5 text-[10px] text-amber-400/80"
              title={`Auto-detected (${inference.reason}) — click a chip to override`}
            >
              <Sparkles className="h-3 w-3" /> auto
            </span>
          )}
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={onPaste}
          placeholder="Add a remark… (paste or drop screenshots, or click 📎)"
          rows={3}
          className="w-full resize-none rounded border border-neutral-800 bg-neutral-950 p-2 text-sm outline-none focus:border-neutral-600"
        />

        {files.length > 0 && (
          <div className="space-y-1">
            {files.map((f, i) => (
              <div
                key={`${f.name}-${i}`}
                className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
              >
                {f.type.startsWith("image/") ? (
                  <ImageIcon className="h-3.5 w-3.5 text-sky-400" />
                ) : (
                  <Paperclip className="h-3.5 w-3.5 text-neutral-400" />
                )}
                <span className="truncate">{f.name}</span>
                <span className="ml-auto text-neutral-500">
                  {(f.size / 1024).toFixed(0)} KB
                </span>
                <button
                  type="button"
                  onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}
                  className="text-neutral-500 hover:text-red-400"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex min-h-[40px] items-center gap-1 rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-700 sm:min-h-0"
          >
            <Paperclip className="h-3 w-3" /> Attach
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf,text/plain,text/markdown"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
            className="hidden"
          />
          <button
            type="submit"
            disabled={pending || !body.trim()}
            className="ml-auto min-h-[40px] rounded bg-white px-4 py-1.5 text-sm font-medium text-black disabled:opacity-40 sm:min-h-0"
          >
            {pending ? "Posting…" : "Post remark"}
          </button>
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
      </form>
    </div>
  );
}

function RemarkItem({
  remark,
  canDelete,
  canResolve,
  onDelete,
  onToggleResolved,
  projectId,
  onJump,
  highlighted,
}: {
  projectId: string;
  remark: Remark;
  canDelete: boolean;
  canResolve: boolean;
  onDelete: () => void;
  onToggleResolved: () => void;
  onJump: (path: string, line: number | null) => void;
  highlighted?: boolean;
}) {
  const looksLikeDir =
    remark.path !== null &&
    !remark.path.split("/").pop()!.includes(".");

  const [expandContext, setExpandContext] = useState(false);

  const resolved = !!remark.resolvedAt;
  return (
    <li
      className={`px-3 py-2.5 text-sm transition ${
        resolved
          ? "opacity-50 [&_p]:line-through"
          : highlighted
            ? "border-l-2 border-emerald-500 bg-emerald-900/10"
            : ""
      }`}
    >
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span className="flex items-center gap-1.5">
          <CategoryBadge category={remark.category} />
          <span className="text-neutral-300">{remark.userName}</span>
          {remark.path ? (
            <span
              className="flex items-center gap-1 truncate rounded bg-neutral-800/70 px-1 py-0.5 font-mono text-[10px]"
              title={remark.path}
            >
              {looksLikeDir ? (
                <FolderIcon className="h-3 w-3 text-sky-400/80" />
              ) : (
                <FileIcon className="h-3 w-3 text-neutral-500" />
              )}
              {remark.path.split("/").slice(-2).join("/")}
              {remark.line !== null && `:${remark.line}`}
            </span>
          ) : (
            <span className="rounded bg-indigo-900/40 px-1 py-0.5 text-[10px] text-indigo-300">
              project
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {canResolve && (
            <button
              type="button"
              onClick={onToggleResolved}
              className={`rounded p-0.5 transition ${
                resolved
                  ? "text-emerald-400 hover:text-neutral-400"
                  : "text-neutral-600 hover:text-emerald-400"
              }`}
              title={resolved ? "Mark as open again" : "Mark as resolved"}
            >
              {resolved ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Circle className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {remark.path && !looksLikeDir && (
            <button
              type="button"
              onClick={() => onJump(remark.path!, remark.line)}
              className="text-neutral-500 hover:text-emerald-400"
              title={`Jump to ${remark.path}${
                remark.line !== null ? `:${remark.line}` : ""
              }`}
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          <span>{relTime(remark.createdAt)}</span>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="text-neutral-600 hover:text-red-400"
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-neutral-200">{remark.body}</p>
      {remark.context && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setExpandContext((v) => !v)}
            className="flex items-center gap-1 rounded border border-emerald-800/50 bg-emerald-900/10 px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-900/20"
            title="Element captured from the preview at post time"
          >
            <MousePointerClick className="h-3 w-3" />
            {expandContext ? "hide element" : "show element"}
          </button>
          {expandContext && <ContextPreview ctx={remark.context} />}
        </div>
      )}
      {remark.attachments.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {remark.attachments.map((a) => {
            const url = `/api/projects/${projectId}/remarks/${remark.id}/attachments/${a.id}`;
            if (a.mimeType.startsWith("image/")) {
              return (
                <a
                  key={a.id}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded border border-neutral-800"
                >
                  <img
                    src={url}
                    alt={a.filename}
                    className="max-h-72 w-auto"
                    loading="lazy"
                  />
                </a>
              );
            }
            return (
              <a
                key={a.id}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs hover:border-neutral-700"
              >
                <Paperclip className="h-3.5 w-3.5 text-neutral-400" />
                <span className="truncate">{a.filename}</span>
                <span className="ml-auto text-neutral-500">
                  {(a.size / 1024).toFixed(0)} KB
                </span>
              </a>
            );
          })}
        </div>
      )}
    </li>
  );
}

function ContextPreview({ ctx }: { ctx: RemarkContext }) {
  const { tag, id, classes, text, locator } = ctx;
  return (
    <div className="mt-1 space-y-0.5 font-mono text-[10px] text-neutral-300">
      {(tag || id || classes?.length) && (
        <div className="truncate">
          <span className="text-emerald-300">&lt;{tag ?? "?"}&gt;</span>
          {id && <span className="text-amber-300"> #{id}</span>}
          {classes && classes.length > 0 && (
            <span className="text-neutral-500">
              {" "}
              .{classes.slice(0, 3).join(" .")}
              {classes.length > 3 && ` +${classes.length - 3}`}
            </span>
          )}
        </div>
      )}
      {locator && <div className="truncate text-neutral-500">{locator}</div>}
      {text && (
        <div className="truncate text-neutral-400">
          “{text.length > 100 ? text.slice(0, 100) + "…" : text}”
        </div>
      )}
    </div>
  );
}

function CategoryBadge({ category }: { category: Category }) {
  const styles = {
    frontend: "border-sky-800/60 bg-sky-900/30 text-sky-300",
    backend: "border-violet-800/60 bg-violet-900/30 text-violet-300",
    other: "border-neutral-700 bg-neutral-800/70 text-neutral-300",
  } as const;
  return (
    <span
      className={`rounded border px-1 py-0.5 font-mono text-[9px] uppercase ${styles[category]}`}
    >
      {category}
    </span>
  );
}

function FilterChip({
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
      className={`rounded-full border px-2 py-0.5 text-[10px] transition ${
        active
          ? "border-neutral-600 bg-neutral-800 text-white"
          : "border-neutral-800 text-neutral-500 hover:border-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}

function CatBtn({
  active,
  auto,
  onClick,
  children,
}: {
  active: boolean;
  auto?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] transition ${
        active
          ? auto
            ? "border-amber-600/60 bg-amber-900/30 text-amber-200"
            : "border-neutral-500 bg-neutral-800 text-white"
          : "border-neutral-800 text-neutral-500 hover:border-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}

function Info({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-6 text-sm text-neutral-500">{children}</div>
  );
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function prettyError(code: string | undefined): string {
  switch (code) {
    case "body_required":
      return "Write something first.";
    case "invalid_category":
      return "Pick frontend, backend, or other.";
    case "too_many_files":
      return "Max 5 attachments per remark.";
    case "file_too_large":
      return "Files must be under 5 MB.";
    default:
      if (code?.startsWith("unsupported_type:")) {
        return `File type not allowed (${code.slice("unsupported_type:".length)}).`;
      }
      return "Failed to post.";
  }
}
