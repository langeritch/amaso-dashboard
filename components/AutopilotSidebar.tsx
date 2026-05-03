"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, X, Zap } from "lucide-react";
import { useSpar } from "./SparContext";

// Preset directive chips. Tapping one populates the textarea so the
// user can either fire it as-is or massage the wording before
// saving. Empty by design — the autopilot prompt already falls back
// to goals + remarks when the directive is blank, so these are just
// shortcuts for common stances.
const DIRECTIVE_PRESETS: { label: string; text: string }[] = [
  {
    label: "Revenue focus",
    text: "Focus on revenue. Prioritise badkamerstijl, woonklasse and client work — anything that brings money in this week.",
  },
  {
    label: "Creative exploration",
    text: "Explore something creative. Spin up new ideas, experiment with the portfolio, and surface options I haven't considered.",
  },
  {
    label: "Maintenance & cleanup",
    text: "Today is maintenance. Drain the open remark queue, clean up tech debt, resolve flaky issues, and keep things tidy.",
  },
  {
    label: "Team onboarding",
    text: "Focus on getting the team productive — Jona's onboarding, internal docs, smoothing handoffs, anything that makes the team move faster.",
  },
];

/**
 * Right-side drawer for autopilot controls. Mirrors SparSidebar's
 * unpinned mode (slide-in overlay with backdrop) but anchored to the
 * right edge. Sections, top-to-bottom:
 *
 *   1. Directive — strategic north star the autonomous loop reads when
 *      picking and creating tasks. Persisted via /api/spar/autopilot/
 *      directive (independent of the on/off toggle).
 *   2. Current task — placeholder for the dispatch the loop is
 *      working on right now.
 *   3. Needs human — open remarks tagged "needs-human" across every
 *      project the user can see. Fed from /api/spar/autopilot/needs-
 *      human.
 *   4. Decision log — placeholder for autopilot's recent decisions.
 *
 * No pinning yet — this is a drawer-only component.
 */
export default function AutopilotSidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { autopilot } = useSpar();

  const [directive, setDirective] = useState("");
  const [savedDirective, setSavedDirective] = useState("");
  const [directiveLoading, setDirectiveLoading] = useState(false);
  const [directiveSaving, setDirectiveSaving] = useState(false);

  const [needsHuman, setNeedsHuman] = useState<NeedsHumanRemark[]>([]);
  const [needsHumanLoading, setNeedsHumanLoading] = useState(false);

  // Hydrate the directive + needs-human list every time the drawer
  // opens so the user sees fresh data without having to reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setDirectiveLoading(true);
      try {
        const res = await fetch("/api/spar/autopilot/directive");
        if (!res.ok) return;
        const json = (await res.json()) as { directive?: string };
        if (cancelled) return;
        const next = json.directive ?? "";
        setDirective(next);
        setSavedDirective(next);
      } catch {
        /* network blip — keep whatever we have */
      } finally {
        if (!cancelled) setDirectiveLoading(false);
      }
    })();
    void (async () => {
      setNeedsHumanLoading(true);
      try {
        const res = await fetch("/api/spar/autopilot/needs-human");
        if (!res.ok) return;
        const json = (await res.json()) as { remarks?: NeedsHumanRemark[] };
        if (cancelled) return;
        setNeedsHuman(json.remarks ?? []);
      } catch {
        /* network blip */
      } finally {
        if (!cancelled) setNeedsHumanLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ESC closes the drawer. Mirrors SparPageShell's behaviour.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const dirty = directive !== savedDirective;

  const saveDirective = async () => {
    if (directiveSaving) return;
    setDirectiveSaving(true);
    try {
      const res = await fetch("/api/spar/autopilot/directive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directive }),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { directive?: string };
      const next = json.directive ?? "";
      setDirective(next);
      setSavedDirective(next);
      // Notify SparProvider so the autopilot prompt picks up the new
      // directive on the very next dispatch completion without a
      // page reload. Plain CustomEvent avoids wiring a new context
      // field for a fire-and-forget signal.
      try {
        window.dispatchEvent(
          new CustomEvent("spar:autopilot-directive-changed"),
        );
      } catch {
        /* SSR safety — no-op when window is missing */
      }
    } catch {
      /* leave the local edit alone — user can retry */
    } finally {
      setDirectiveSaving(false);
    }
  };

  const applyPreset = (text: string) => {
    setDirective(text);
  };

  return (
    <>
      <button
        type="button"
        aria-label="close autopilot panel"
        tabIndex={-1}
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/60 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        aria-label="autopilot sidebar"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-40 flex w-72 max-w-[85vw] flex-col border-l border-neutral-800 bg-neutral-950/95 shadow-2xl backdrop-blur transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-3">
          <div className="flex items-center gap-2">
            <Zap
              className={`h-3.5 w-3.5 ${
                autopilot
                  ? "fill-orange-300 text-orange-300 animate-pulse"
                  : "text-neutral-500"
              }`}
            />
            <span className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">
              Autopilot
            </span>
            <span
              className={`text-[10px] uppercase tracking-wider ${
                autopilot ? "text-orange-300" : "text-neutral-600"
              }`}
            >
              {autopilot ? "on" : "off"}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="amaso-fx amaso-press flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200 sm:h-7 sm:w-7"
            aria-label="close autopilot panel"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {/* Directive */}
          <section className="border-b border-neutral-800 px-3 py-3">
            <SectionLabel>Directive</SectionLabel>
            <p className="mt-1 mb-2 text-[11px] leading-snug text-neutral-500">
              Strategic north star. Autopilot reads this when choosing and
              creating tasks.
            </p>
            <textarea
              value={directive}
              onChange={(e) => setDirective(e.target.value)}
              placeholder="leave empty to let autopilot pick from your goals + open remarks"
              rows={4}
              maxLength={2000}
              disabled={directiveLoading}
              className="block w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none disabled:opacity-60"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DIRECTIVE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p.text)}
                  disabled={directiveLoading}
                  className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400 transition hover:border-orange-500/50 hover:text-orange-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-end gap-2">
              {directiveLoading && (
                <Loader2 className="h-3 w-3 animate-spin text-neutral-500" />
              )}
              <button
                type="button"
                onClick={() => void saveDirective()}
                disabled={!dirty || directiveSaving || directiveLoading}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition ${
                  dirty && !directiveSaving
                    ? "border-orange-500/40 bg-orange-500/10 text-orange-200 hover:border-orange-400/60"
                    : "border-neutral-800 bg-neutral-900 text-neutral-500"
                } disabled:cursor-not-allowed`}
              >
                {directiveSaving && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                <span>{dirty ? "Save" : "Saved"}</span>
              </button>
            </div>
          </section>

          {/* Current task */}
          <section className="border-b border-neutral-800 px-3 py-3">
            <SectionLabel>Current task</SectionLabel>
            <p className="mt-2 text-xs italic text-neutral-500">
              No active task
            </p>
          </section>

          {/* Needs human */}
          <section className="border-b border-neutral-800 px-3 py-3">
            <div className="flex items-center justify-between">
              <SectionLabel>Needs human</SectionLabel>
              {needsHumanLoading && (
                <Loader2 className="h-3 w-3 animate-spin text-neutral-500" />
              )}
            </div>
            <NeedsHumanList items={needsHuman} loading={needsHumanLoading} />
          </section>

          {/* Decision log */}
          <section className="px-3 py-3">
            <SectionLabel>Decision log</SectionLabel>
            <p className="mt-2 text-xs italic text-neutral-500">
              No decisions yet
            </p>
          </section>
        </div>
      </aside>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">
      {children}
    </div>
  );
}

interface NeedsHumanRemark {
  id: number;
  projectId: string;
  body: string;
  tags: string[];
  createdAt: number;
  author: string;
}

function NeedsHumanList({
  items,
  loading,
}: {
  items: NeedsHumanRemark[];
  loading: boolean;
}) {
  const sorted = useMemo(
    () => items.slice().sort((a, b) => b.createdAt - a.createdAt),
    [items],
  );
  if (!loading && sorted.length === 0) {
    return (
      <p className="mt-2 text-xs italic text-neutral-500">
        Nothing waiting on you.
      </p>
    );
  }
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {sorted.map((r) => (
        <li
          key={r.id}
          className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[10px] uppercase tracking-wider text-neutral-500">
              {r.projectId}
            </span>
            <button
              type="button"
              onClick={() => {
                /* placeholder — wiring lands later */
              }}
              className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200"
            >
              Handle
            </button>
          </div>
          <p className="mt-1 line-clamp-3 text-xs text-neutral-200">{r.body}</p>
        </li>
      ))}
    </ul>
  );
}
