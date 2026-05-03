"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Save, X } from "lucide-react";
import {
  CurrentHeartbeat,
  Timeline,
  parseHeartbeat,
  useHeartbeatBody,
  useTickHistory,
} from "./HeartbeatView";

const PANEL_POLL_MS = 30_000;

/** Slide-out monitoring panel for the spar page. Same data the /heartbeat
 *  route shows (parsed Now/Today/Open-loops + tick timeline) but rendered
 *  inside a right-edge drawer so the user can audit state without leaving
 *  the conversation. The drawer keeps the existing edit-mode textarea
 *  available behind a small "edit" toggle so we don't lose any current
 *  functionality — the live view is just the new default. */
export default function HeartbeatPanel({
  open,
  onClose,
  userId,
  initialBody,
  canManageOthers = false,
  // Editor wiring — kept exactly the same as the previous SideDrawer in
  // SparFullView so super-users can still flip to a different user's
  // heartbeat and the dirty/save flow is unchanged.
  speakingUserId,
  onSpeakerChange,
  editorBody,
  setEditorBody,
  editorDirty,
  setEditorDirty,
  saving,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  userId: number;
  initialBody: string;
  canManageOthers?: boolean;
  speakingUserId: number;
  onSpeakerChange: (id: number) => void;
  editorBody: string;
  setEditorBody: (s: string) => void;
  editorDirty: boolean;
  setEditorDirty: (b: boolean) => void;
  saving: boolean;
  onSave: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);

  // Whose heartbeat are we viewing? Mirrors the editor's behaviour: a
  // super-user can scope the panel to another user via speakingUserId,
  // everyone else sees themselves.
  const targetUserId = canManageOthers ? speakingUserId : userId;

  const { body } = useHeartbeatBody(
    targetUserId,
    targetUserId === userId ? initialBody : "",
    PANEL_POLL_MS,
    open && !editing,
  );
  const sections = useMemo(() => parseHeartbeat(body), [body]);
  const { ticks, loading, error, reload } = useTickHistory(
    targetUserId,
    PANEL_POLL_MS,
    open,
  );

  // ESC closes the panel — matches the rest of the spar drawers and is
  // a natural keyboard expectation for a slide-out.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // When the panel opens or the user toggles back from edit mode, scroll
  // the content to the top — otherwise a previously-scrolled timeline
  // can read as "panel is broken" on reopen.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || editing) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [open, editing]);

  return (
    <div
      className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="close heartbeat"
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        className={`absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-neutral-950 shadow-xl transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-label="heartbeat panel"
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3 text-sm">
          <span className="text-xs uppercase tracking-[0.22em] text-neutral-500">
            heartbeat
          </span>
          {canManageOthers && (
            <label className="ml-2 flex items-center gap-1 text-[11px] text-neutral-500">
              user
              <input
                type="number"
                min={1}
                value={speakingUserId}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0) onSpeakerChange(n);
                }}
                className="w-14 rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-right text-[11px] text-neutral-200"
              />
            </label>
          )}
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
            className={`ml-auto flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] transition ${
              editing
                ? "border-orange-500/60 bg-orange-500/10 text-orange-200"
                : "border-neutral-700 text-neutral-300 hover:border-neutral-600 hover:text-neutral-100"
            }`}
            title={editing ? "back to live view" : "edit heartbeat"}
          >
            <Pencil className="h-3 w-3" />
            {editing ? "viewing edit" : "edit"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {editing ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
              <span className="text-[11px] text-neutral-500">
                Edit raw markdown — Now / Today / Open loops
              </span>
              <button
                type="button"
                disabled={!editorDirty || saving}
                onClick={() => void onSave()}
                className="ml-auto flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-600 disabled:opacity-40"
              >
                <Save className="h-3 w-3" /> {saving ? "…" : "save"}
              </button>
            </div>
            <textarea
              value={editorBody}
              onChange={(e) => {
                setEditorBody(e.target.value);
                setEditorDirty(true);
              }}
              spellCheck={false}
              className="flex-1 resize-none bg-neutral-950 px-3 py-2 font-mono text-[12px] leading-relaxed text-neutral-200 focus:outline-none"
              placeholder={"## Now\n- \n\n## Today\n- \n\n## Open loops\n- "}
            />
          </div>
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-5">
            <div className="flex flex-col gap-5">
              <CurrentHeartbeat sections={sections} />
              <Timeline
                ticks={ticks}
                loading={loading}
                error={error}
                onReload={reload}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
