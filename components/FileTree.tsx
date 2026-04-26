"use client";

import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Target,
} from "lucide-react";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
  size?: number;
}

export interface Selection {
  path: string;
  type: "file" | "dir";
}

interface Props {
  nodes: TreeNode[];
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
  modifiedPaths?: Set<string>;
  untrackedPaths?: Set<string>;
}

export default function FileTree({
  nodes,
  selected,
  onSelect,
  modifiedPaths,
  untrackedPaths,
}: Props) {
  return (
    <ul className="text-sm">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          selected={selected}
          onSelect={onSelect}
          modifiedPaths={modifiedPaths}
          untrackedPaths={untrackedPaths}
        />
      ))}
    </ul>
  );
}

function dirHasEdits(
  dirPath: string,
  set: Set<string> | undefined,
): boolean {
  if (!set || set.size === 0) return false;
  const prefix = dirPath + "/";
  for (const p of set) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

function TreeItem({
  node,
  depth,
  selected,
  onSelect,
  modifiedPaths,
  untrackedPaths,
}: {
  node: TreeNode;
  depth: number;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
  modifiedPaths?: Set<string>;
  untrackedPaths?: Set<string>;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isSelected =
    selected?.path === node.path && selected.type === node.type;
  const padding = { paddingLeft: `${depth * 12 + 6}px` };

  let badge: { label: string; className: string; title: string } | null = null;
  if (node.type === "file") {
    if (modifiedPaths?.has(node.path)) {
      badge = {
        label: "M",
        className: "bg-amber-900/60 text-amber-200 border-amber-700/70",
        title: "Modified since last commit",
      };
    } else if (untrackedPaths?.has(node.path)) {
      badge = {
        label: "U",
        className: "bg-emerald-900/60 text-emerald-200 border-emerald-700/70",
        title: "New file — not yet tracked by git",
      };
    }
  } else if (
    dirHasEdits(node.path, modifiedPaths) ||
    dirHasEdits(node.path, untrackedPaths)
  ) {
    badge = {
      label: "•",
      className: "bg-amber-900/40 text-amber-200 border-amber-700/40",
      title: "Contains edited or new files",
    };
  }

  const select = () => onSelect({ path: node.path, type: node.type });

  if (node.type === "dir") {
    return (
      <li>
        <div
          style={padding}
          className={`group flex w-full items-center gap-1 rounded py-1.5 sm:py-0.5 ${
            isSelected
              ? "bg-emerald-900/30 text-emerald-100 ring-1 ring-emerald-700/50"
              : "text-neutral-300 hover:bg-neutral-800/50"
          }`}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-label={open ? "Collapse folder" : "Expand folder"}
            className="flex-shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              select();
            }}
            className="flex flex-1 items-center gap-1 overflow-hidden text-left"
          >
            {open ? (
              <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-sky-400/80" />
            ) : (
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-sky-400/80" />
            )}
            <span className="truncate">{node.name}</span>
            {badge && <Badge {...badge} />}
          </button>
          <TargetBtn active={isSelected} onClick={select} />
        </div>
        {open && node.children && node.children.length > 0 && (
          <ul>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
                modifiedPaths={modifiedPaths}
                untrackedPaths={untrackedPaths}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <div
        style={padding}
        className={`group flex w-full items-center gap-1 rounded py-0.5 ${
          isSelected
            ? "bg-emerald-900/30 text-emerald-100 ring-1 ring-emerald-700/50"
            : "text-neutral-300 hover:bg-neutral-800/50"
        }`}
      >
        <button
          type="button"
          onClick={select}
          className="flex flex-1 items-center gap-1 overflow-hidden text-left"
        >
          <span className="w-4 flex-shrink-0" />
          <File className="h-3.5 w-3.5 flex-shrink-0 text-neutral-500" />
          <span className="truncate">{node.name}</span>
          {badge && <Badge {...badge} />}
        </button>
        <TargetBtn active={isSelected} onClick={select} />
      </div>
    </li>
  );
}

function TargetBtn({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={active ? "Currently targeted" : "Use as remark target"}
      className={`mr-1 flex-shrink-0 rounded p-0.5 transition ${
        active
          ? "text-emerald-300"
          : "text-neutral-600 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
      }`}
    >
      <Target className="h-3 w-3" />
    </button>
  );
}

function Badge({
  label,
  className,
  title,
}: {
  label: string;
  className: string;
  title: string;
}) {
  return (
    <span
      title={title}
      className={`ml-auto flex-shrink-0 rounded border px-1 py-px text-[9px] font-medium ${className}`}
    >
      {label}
    </span>
  );
}
