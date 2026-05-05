"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Activity, Send, Zap } from "lucide-react";
import { useSparOptional } from "./SparContext";
import { useSparFooter } from "./SparFooterContext";
import { SparMediaRow } from "./SparMiniPlayer";
import HeartbeatPanel from "./HeartbeatPanel";
import { useLatestTick } from "./HeartbeatView";
import { useSignoffWord } from "@/lib/tts-signoff";

/**
 * Page-level unified footer rendered on every authenticated page
 * EXCEPT /spar — there SparFullView claims the footer slot and
 * renders its own richer version (queue list, slash commands,
 * mode toggle). Layout is identical so the strip feels consistent
 * as the user navigates: media on the left, composer flexing in
 * the centre, autopilot + heartbeat on the right.
 *
 * On /team the composer is hidden — TeamHub's ChatClient already
 * owns its own typing input and a duplicate would confuse users.
 *
 * Shrink rules: media + actions are `flex-shrink-0` (must never
 * clip), composer is `flex-1 min-w-0` so it's the first thing to
 * compress when the viewport narrows.
 */
export default function GlobalFooter() {
  const pathname = usePathname();
  const spar = useSparOptional();
  const footerCtx = useSparFooter();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [heartbeatOpen, setHeartbeatOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const userId = spar?.currentUser.id ?? 0;
  const latestTick = useLatestTick(userId);

  // Publish the rendered footer's height into context + a CSS var so
  // any consumer that needs to reserve bottom space stays in sync as
  // the strip grows with safe-area insets.
  const setFooterHeight = footerCtx?.setFooterHeight;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      document.documentElement.style.removeProperty("--spar-footer-h");
      if (setFooterHeight) setFooterHeight(0);
      return;
    }
    const publish = (h: number) => {
      const px = Math.ceil(h);
      document.documentElement.style.setProperty(
        "--spar-footer-h",
        `${px}px`,
      );
      if (setFooterHeight) setFooterHeight(px);
    };
    publish(el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0];
        const h = box ? box.blockSize : entry.contentRect.height;
        publish(h);
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--spar-footer-h");
      if (setFooterHeight) setFooterHeight(0);
    };
  }, [setFooterHeight]);

  // Auto-grow textarea up to ~4 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const submit = useCallback(async () => {
    if (!spar) return;
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await spar.sendMessage(text);
      setDraft("");
    } finally {
      setSending(false);
    }
  }, [draft, sending, spar]);

  // SparFullView (on /spar) claims the slot — bail so we don't
  // double-render the strip. Also bail when there's no spar
  // context (login / setup pages).
  if (footerCtx?.footerActive) return null;
  if (!spar) return null;

  const hideComposer = pathname === "/team";

  return (
    <>
      <div
        ref={containerRef}
        className="pb-safe pointer-events-auto fixed inset-x-0 bottom-0 z-30 border-t border-neutral-800/80 bg-neutral-950/85 shadow-[0_-8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md backdrop-saturate-150"
      >
        <div className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
          {/* LEFT — media controls. flex-shrink-0 so play/skip/volume/
              PiP never get clipped at narrow widths. */}
          <div className="flex flex-shrink-0 items-center gap-1.5 min-w-0 max-w-[18rem] sm:max-w-[22rem]">
            <SparMediaRow compact />
            <SignoffChip />
          </div>

          {/* CENTER + RIGHT — composer + actions on a shared line.
              On phones this wrapper holds them as a flex row stacked
              under media; from sm: up the wrapper becomes contents
              so its children sit next to media in the outer flex. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:contents">
            {hideComposer ? (
              // No composer on /team — TeamHub owns its own input.
              // Keep a flex spacer so the actions cluster sticks to
              // the right edge.
              <div className="flex-1" />
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
                className="relative mx-auto flex min-w-0 max-w-3xl flex-1 items-end gap-1.5 rounded-2xl border border-neutral-800 bg-neutral-900/70 px-2.5 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[border-color,box-shadow,background-color] duration-200 ease-out focus-within:border-orange-500/50 focus-within:bg-neutral-900/85 focus-within:shadow-[0_0_0_3px_rgba(255,107,61,0.12),0_1px_2px_rgba(0,0,0,0.25)]"
              >
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="message your sparring partner…"
                  className="min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-neutral-100 placeholder-neutral-500 transition-[height] duration-150 ease-out focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || sending}
                  className="amaso-fx amaso-press flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-orange-500 text-neutral-950 shadow-[0_2px_8px_rgba(255,107,61,0.35)] hover:bg-orange-400 hover:shadow-[0_2px_12px_rgba(255,107,61,0.5)] disabled:bg-neutral-700 disabled:text-neutral-400 disabled:shadow-none"
                  aria-label="Send"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
            )}

            {/* RIGHT — autopilot + heartbeat. flex-shrink-0 so the
                cluster never gets clipped; labels collapse on phones
                via `hidden sm:inline`. */}
            <div className="flex flex-shrink-0 items-center gap-1 sm:ml-auto sm:gap-1.5">
              <button
                type="button"
                onClick={spar.toggleAutopilot}
                aria-pressed={spar.autopilot}
                aria-label={
                  spar.autopilot
                    ? "autopilot on — spar handles permission gates itself"
                    : "autopilot off — spar asks before acting"
                }
                title={
                  spar.autopilot
                    ? "autopilot on — spar handles permission gates itself"
                    : "autopilot off — spar asks before acting"
                }
                className={`group inline-flex h-8 items-center gap-1.5 rounded-full border px-2 text-[11px] transition sm:px-3 ${
                  spar.autopilot
                    ? "border-orange-400/60 bg-orange-500/15 text-orange-200 shadow-[0_0_18px_rgba(255,107,61,0.45)] hover:border-orange-300/80"
                    : "border-neutral-800 bg-neutral-900/80 text-neutral-300 hover:border-neutral-700 hover:text-neutral-200"
                }`}
              >
                <Zap
                  className={`h-3.5 w-3.5 ${
                    spar.autopilot
                      ? "fill-orange-300 text-orange-300 animate-pulse"
                      : "text-neutral-500 group-hover:text-neutral-300"
                  }`}
                />
                <span className="hidden sm:inline">autopilot</span>
              </button>
              <button
                type="button"
                onClick={() => setHeartbeatOpen((v) => !v)}
                aria-label={heartbeatOpen ? "close heartbeat" : "open heartbeat"}
                aria-pressed={heartbeatOpen}
                title={heartbeatOpen ? "close heartbeat" : "open heartbeat"}
                className={`relative inline-flex h-8 items-center gap-1.5 rounded-full border px-2 text-[11px] transition sm:px-3 ${
                  heartbeatOpen
                    ? "border-orange-400/60 bg-orange-500/15 text-orange-100 shadow-[0_0_18px_rgba(255,107,61,0.35)]"
                    : "border-neutral-800 bg-neutral-900/80 text-neutral-300 hover:border-neutral-700 hover:text-neutral-200"
                }`}
              >
                <Activity className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">heartbeat</span>
                {latestTick && (
                  <span
                    aria-hidden
                    title={
                      latestTick.status === "ok"
                        ? "last tick: ok"
                        : latestTick.notified
                          ? "last tick: alert pushed"
                          : "last tick: alert (silent)"
                    }
                    className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ${
                      latestTick.status === "ok"
                        ? "bg-orange-400"
                        : latestTick.notified
                          ? "bg-amber-400 animate-pulse"
                          : "bg-amber-400/70"
                    } shadow-[0_0_6px_currentColor]`}
                  />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <HeartbeatPanel
        open={heartbeatOpen}
        onClose={() => setHeartbeatOpen(false)}
        userId={spar.currentUser.id}
        initialBody={spar.heartbeat}
        canManageOthers={spar.canManageOthers}
        speakingUserId={spar.speakingUserId}
        onSpeakerChange={spar.loadHeartbeatFor}
        editorBody={spar.heartbeat}
        setEditorBody={spar.setHeartbeat}
        editorDirty={spar.heartbeatDirty}
        setEditorDirty={spar.setHeartbeatDirty}
        saving={spar.savingHeartbeat}
        onSave={spar.saveHeartbeat}
      />
    </>
  );
}

function SignoffChip() {
  const [word, setWord] = useSignoffWord();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(word);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(word);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, word]);

  const commit = () => {
    setWord(draft.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        placeholder="off"
        className="h-6 w-20 rounded-full border border-orange-500/50 bg-neutral-900 px-2 text-[11px] text-neutral-100 placeholder-neutral-500 focus:outline-none"
      />
    );
  }

  const label = word.trim() ? word : "off";
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="TTS sign-off word (click to edit, empty disables)"
      className={`inline-flex h-6 items-center rounded-full border px-2 text-[11px] transition ${
        word.trim()
          ? "border-neutral-700 bg-neutral-900/80 text-neutral-300 hover:border-neutral-600 hover:text-neutral-100"
          : "border-neutral-800 bg-neutral-900/60 text-neutral-500 hover:border-neutral-700 hover:text-neutral-400"
      }`}
    >
      {label}
    </button>
  );
}
