"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  MessageSquarePlus,
  Pin,
  PinOff,
  Trash2,
  X,
} from "lucide-react";
import { useSpar, type SparConversationSummary } from "./SparContext";
import { WorkerList } from "./WorkerStatusPanel";

/**
 * Left sidebar for the spar page. Two stacked sections:
 *
 *   1. Chats — every conversation the current user has, newest
 *      first. Clicking a row hydrates that chat in the chat pane.
 *      The "new chat" button up top clears the active selection so
 *      the next message lands in a freshly-created conversation row.
 *
 *   2. Workers — the existing mission-control list, lifted out of
 *      the chat overlay and given a permanent home in the sidebar.
 *      Renders one row per project (running or stopped) just like
 *      the legacy panel, so the sidebar mirrors `/api/spar/worker-
 *      status` 1:1. Collapsible from the sidebar header.
 *
 * Two render modes, driven by the parent shell:
 *
 *   - **Unpinned (default):** fixed-position overlay drawer. Closed
 *     by default so the chat composer + media row stay
 *     unobstructed. A hamburger in the page-shell toggles it; the
 *     drawer animates in over a backdrop.
 *
 *   - **Pinned:** in-flow column. The sidebar takes its own width
 *     in the layout and the chat shrinks to fit alongside. No
 *     backdrop, no slide animation, no hamburger or close button —
 *     the user explicitly asked for a permanent column. Persisted
 *     in localStorage; auto-disabled on small viewports where
 *     there isn't room for both.
 */
export default function SparSidebar({
  open,
  pinned,
  canPin,
  onClose,
  onTogglePin,
}: {
  open: boolean;
  pinned: boolean;
  canPin: boolean;
  onClose: () => void;
  onTogglePin: () => void;
}) {
  const {
    conversations,
    activeConversationId,
    selectConversation,
    newConversation,
    deleteConversation,
    refreshConversations,
  } = useSpar();

  const [workersCollapsed, setWorkersCollapsed] = useState(false);

  // Periodically refresh the chat list so updates from other
  // devices land without forcing the user to reload — the WS push
  // already handles the "message arrived" path, but a polling
  // fallback covers the cases the socket misses (mount race,
  // network blip).
  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshConversations();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [refreshConversations]);

  // Pinned mode: the sidebar is rendered in flow (no fixed/overlay
  // chrome, no transform, no backdrop). The shell wraps it in a
  // flex-row so the main content shrinks to fit alongside.
  // Unpinned mode: classic slide-in drawer with backdrop.
  const asideClass = pinned
    ? "relative z-10 flex h-full w-72 flex-shrink-0 flex-col border-r border-neutral-800/80 bg-neutral-950/95"
    : `fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col border-r border-neutral-800/80 bg-neutral-950/95 shadow-2xl backdrop-blur-md backdrop-saturate-150 transition-transform duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
        open ? "translate-x-0" : "-translate-x-full"
      }`;

  // Selecting a chat / starting a new chat closes the drawer when
  // it's overlaying — but when pinned the sidebar is the persistent
  // home for the list, so closing it would be a UX regression. Wrap
  // the close call with this gate so click handlers stay one-liners.
  const closeIfDrawer = () => {
    if (!pinned) onClose();
  };

  const sidebar = (
    <aside aria-label="spar sidebar" aria-hidden={!pinned && !open} className={asideClass}>
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-3">
        <span className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">
          Chats
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              newConversation();
              closeIfDrawer();
            }}
            className="amaso-fx amaso-press flex min-h-[36px] items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 hover:border-neutral-700 hover:bg-neutral-800"
            aria-label="new chat"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            <span>New</span>
          </button>
          {canPin && (
            <button
              type="button"
              onClick={onTogglePin}
              className={`amaso-fx amaso-press flex h-9 w-9 items-center justify-center rounded-md sm:h-7 sm:w-7 ${
                pinned
                  ? "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                  : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
              }`}
              aria-label={pinned ? "unpin sidebar" : "pin sidebar"}
              aria-pressed={pinned}
              title={pinned ? "Unpin (back to drawer)" : "Pin (always visible)"}
            >
              {pinned ? (
                <PinOff className="h-3.5 w-3.5" />
              ) : (
                <Pin className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {!pinned && (
            <button
              type="button"
              onClick={onClose}
              className="amaso-fx amaso-press flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200 sm:h-7 sm:w-7"
              aria-label="close sidebar"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>
      <ChatList
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelect={async (id) => {
          await selectConversation(id);
          closeIfDrawer();
        }}
        onDelete={async (id) => {
          await deleteConversation(id);
        }}
      />
      <div className="border-t border-neutral-800/80">
        <button
          type="button"
          onClick={() => setWorkersCollapsed((c) => !c)}
          className="amaso-fx flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-[11px] uppercase tracking-[0.22em] text-neutral-500 hover:bg-neutral-900/40 hover:text-neutral-300 sm:min-h-0"
          aria-expanded={!workersCollapsed}
        >
          <span>Workers</span>
          <span
            className={`amaso-fx inline-flex transition-transform duration-200 ${
              workersCollapsed ? "" : "rotate-90"
            }`}
            aria-hidden
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </button>
        <div
          data-open={workersCollapsed ? "false" : "true"}
          aria-hidden={workersCollapsed}
          className="amaso-collapse"
          style={{ maxHeight: workersCollapsed ? 0 : "40vh" }}
        >
          {/* Inner scrollable region. amaso-collapse sets overflow:
              hidden on the parent (so the height transition clips),
              so we put the actual scroll on this child with its own
              cap. Both share 40vh, so no compounding clip. */}
          <div className="max-h-[40vh] overflow-y-auto pb-2">
            <WorkerList />
          </div>
        </div>
      </div>
    </aside>
  );

  // Pinned: no backdrop, no fragment wrapper — just the column.
  if (pinned) return sidebar;

  return (
    <>
      {/* Backdrop. Click-outside dismisses the drawer. Pointer-events
          are off when the drawer is closed so the chat composer + the
          media row underneath remain fully clickable — without this
          gate the invisible button would still swallow taps. */}
      <button
        type="button"
        aria-label="close sidebar"
        tabIndex={-1}
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/70 backdrop-blur-sm transition-opacity duration-300 ease-out ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      {sidebar}
    </>
  );
}

function ChatList({
  conversations,
  activeConversationId,
  onSelect,
  onDelete,
}: {
  conversations: SparConversationSummary[];
  activeConversationId: number | null;
  onSelect: (id: number) => void | Promise<void>;
  onDelete: (id: number) => void | Promise<void>;
}) {
  const sorted = useMemo(
    () => conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );
  if (sorted.length === 0) {
    return (
      <div className="amaso-fade-in flex-1 px-4 py-8 text-center text-xs leading-relaxed text-neutral-500">
        <p className="font-medium text-neutral-300">No chats yet.</p>
        <p className="mt-1 text-neutral-500">
          Tap <span className="text-neutral-300">New</span> above to start one.
        </p>
      </div>
    );
  }
  return (
    <ul className="amaso-fade-in flex-1 overflow-y-auto py-1">
      {sorted.map((c) => {
        const active = c.id === activeConversationId;
        return (
          <li key={c.id}>
            <div
              className={`group amaso-fx relative flex min-h-[56px] items-center gap-2 px-3 py-2 ${
                active
                  ? "bg-neutral-900 text-neutral-100 shadow-[inset_2px_0_0_rgb(255,107,61)]"
                  : "text-neutral-300 hover:bg-neutral-900/60 active:bg-neutral-900/80"
              }`}
            >
              <button
                type="button"
                onClick={() => void onSelect(c.id)}
                title={c.title || "New chat"}
                className="flex min-w-0 flex-1 flex-col items-start text-left"
              >
                <span className="w-full truncate text-sm">
                  {c.title || "New chat"}
                </span>
                <span className="flex w-full items-center gap-2 text-[10px] uppercase tracking-wider text-neutral-500">
                  <span>{relativeTime(c.updatedAt)}</span>
                  {c.messageCount > 0 && (
                    <>
                      <span className="text-neutral-700">·</span>
                      <span>{c.messageCount} msg</span>
                    </>
                  )}
                </span>
                {c.preview && (
                  <span className="mt-0.5 line-clamp-1 w-full text-[11px] text-neutral-500">
                    {c.preview}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm("Delete this chat?")) {
                    void onDelete(c.id);
                  }
                }}
                // Always visible on touch devices (no hover to reveal);
                // only fades in on hover on pointer-fine displays.
                className="amaso-fx amaso-press flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 sm:invisible sm:h-7 sm:w-7 sm:group-hover:visible sm:focus-visible:visible"
                aria-label="delete chat"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  if (diff < 7 * 24 * 60 * 60_000) {
    return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
  }
  return new Date(ts).toLocaleDateString();
}
