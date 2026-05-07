"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { useSpar } from "./SparContext";

// Preset chips for the custom-instructions textarea. Tapping one
// populates the textarea so the user can fire it as-is or massage
// the wording before saving. Keep these short and steerable — the
// instructions ride along on every auto-report regardless of mode.
const INSTRUCTION_PRESETS: { label: string; text: string }[] = [
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

// Sample data the prompt-preview pane uses so the user can see the
// shape of the message that will fire without waiting for a real
// terminal to complete. Two projects + short prompts = a typical
// burst, big enough to show the bullet-list shape, small enough to
// fit in a sidebar.
const PREVIEW_PROJECTS: { label: string; prompt: string }[] = [
  { label: "badkamerstijl", prompt: "Add a contact form to the homepage." },
  { label: "woonklasse", prompt: "Fix the broken image carousel on /products." },
];

function buildPreviewNudge(customInstructions: string): string {
  const labels = PREVIEW_PROJECTS.map((p) => p.label).join(", ");
  const promptLines = PREVIEW_PROJECTS.map(
    (p) => `- ${p.label}: ${p.prompt}`,
  );
  const trimmed = customInstructions.trim();
  const instructionsBlock =
    trimmed.length > 0 ? `\n\nCustom instructions:\n${trimmed}` : "";
  return (
    `Check the output of terminal for ${labels}. ` +
    `For each project, read the terminal to see if the dispatched task ` +
    `finished successfully. If it did, resolve any open remark that ` +
    `matches the task using resolve_remark.\n\n` +
    `Last sent prompts:\n${promptLines.join("\n")}` +
    instructionsBlock
  );
}

// Compressed summary of what the smart-mode addon does. The actual
// addon block (lib/autopilot-prompt.ts) is ~1.2kB of decision-chain
// text that we don't need to mirror verbatim in the UI; the bullet
// list captures the practical effect without scrolling forever.
const SMART_MODE_BULLETS: string[] = [
  "Reads each terminal and judges success vs failure per project.",
  "Resolves any matching open remark with resolve_remark.",
  "Tags failed tasks for retry; needs-human items get parked.",
  "Picks the next-highest-leverage remark and dispatches it.",
  "Creates new remarks when the queue is empty so the loop keeps moving.",
];

/**
 * Auto-report configuration drawer. Right-side overlay, shows what
 * the auto-report system will send when a dispatched terminal goes
 * idle, lets the user toggle smart mode (richer prompt + autonomous
 * loop), and exposes the custom-instructions field that rides along
 * on every auto-report regardless of mode.
 *
 * Sections, top-to-bottom:
 *   1. Smart mode toggle — flips the prompt template basic ↔ smart.
 *   2. Custom instructions — appended to every nudge.
 *   3. Prompt preview — live-rendered with sample projects.
 *   4. Needs human — open remarks tagged "needs-human" (smart-mode
 *      tagging puts them here).
 *   5. Recent auto-reports — completed dispatches, newest first.
 */
export default function AutopilotSidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { autopilot, toggleAutopilot, dispatches } = useSpar();

  const [directive, setDirective] = useState("");
  const [savedDirective, setSavedDirective] = useState("");
  const [directiveLoading, setDirectiveLoading] = useState(false);
  const [directiveSaving, setDirectiveSaving] = useState(false);

  const [needsHuman, setNeedsHuman] = useState<NeedsHumanRemark[]>([]);
  const [needsHumanLoading, setNeedsHumanLoading] = useState(false);

  const [showSmartAddon, setShowSmartAddon] = useState(false);

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
      // Notify SparProvider so any cached directive picks up the new
      // value on the very next dispatch completion without a page
      // reload. Plain CustomEvent keeps the wiring lightweight.
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

  // Use the SAVED directive (not the in-flight edit) for the preview
  // so the displayed prompt reflects what would actually fire right
  // now. The instructions block hides entirely when nothing is saved.
  const previewNudge = useMemo(
    () => buildPreviewNudge(savedDirective),
    [savedDirective],
  );

  const completedDispatches = useMemo(() => {
    return dispatches
      .filter((d) => d.completedAt != null)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 8);
  }, [dispatches]);

  return (
    <>
      <button
        type="button"
        aria-label="close auto-report panel"
        tabIndex={-1}
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/70 backdrop-blur-sm transition-opacity duration-300 ease-out ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        aria-label="auto-report sidebar"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-40 flex w-80 max-w-[90vw] flex-col border-l border-neutral-800/80 bg-neutral-950/95 shadow-2xl backdrop-blur-md backdrop-saturate-150 transition-transform duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-start justify-between gap-2 border-b border-neutral-800 px-3 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] uppercase tracking-[0.22em] text-neutral-400">
              Auto-report
            </span>
            <span className="text-[10px] leading-snug text-neutral-500">
              Fires when a dispatched terminal completes.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="amaso-fx amaso-press flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200 sm:h-7 sm:w-7"
            aria-label="close auto-report panel"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {/* Smart mode */}
          <section className="border-b border-neutral-800 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <SectionLabel>Smart mode</SectionLabel>
                <p className="mt-1 text-[11px] leading-snug text-neutral-500">
                  {autopilot
                    ? "On — spar evaluates each terminal, resolves matching remarks, and dispatches the next task autonomously."
                    : "Off — spar just nudges you to read the terminal output. No autonomous follow-up."}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autopilot}
                onClick={toggleAutopilot}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition ${
                  autopilot
                    ? "bg-orange-500/80"
                    : "bg-neutral-800 hover:bg-neutral-700"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-neutral-100 shadow transition ${
                    autopilot ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            {autopilot && (
              <button
                type="button"
                onClick={() => setShowSmartAddon((v) => !v)}
                className="mt-2 flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
              >
                <Sparkles className="h-3 w-3" />
                <span>{showSmartAddon ? "Hide" : "What smart mode does"}</span>
              </button>
            )}
            {autopilot && showSmartAddon && (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-snug text-neutral-400">
                {SMART_MODE_BULLETS.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </section>

          {/* Custom instructions */}
          <section className="border-b border-neutral-800 px-3 py-3">
            <SectionLabel>Custom instructions</SectionLabel>
            <p className="mt-1 mb-2 text-[11px] leading-snug text-neutral-500">
              Appended to every auto-report — basic and smart mode alike.
              Leave empty to rely on goals + open remarks.
            </p>
            <textarea
              value={directive}
              onChange={(e) => setDirective(e.target.value)}
              placeholder="e.g. focus on revenue; skip anything that needs my judgment"
              rows={4}
              maxLength={2000}
              disabled={directiveLoading}
              className="block w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none disabled:opacity-60"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {INSTRUCTION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p.text)}
                  disabled={directiveLoading}
                  className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400 amaso-fx hover:border-orange-500/50 hover:text-orange-200 disabled:cursor-not-allowed disabled:opacity-50"
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

          {/* Prompt preview */}
          <section className="border-b border-neutral-800 px-3 py-3">
            <SectionLabel>Prompt preview</SectionLabel>
            <p className="mt-1 mb-2 text-[11px] leading-snug text-neutral-500">
              Sample with two projects. Swap labels and prompt text mentally
              for whatever just finished.
            </p>
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-2 text-[10px] leading-relaxed text-neutral-300">
              {previewNudge}
            </pre>
            {autopilot && (
              <p className="mt-2 text-[10px] leading-snug text-neutral-500">
                Smart mode also adds a system-level decision chain that
                tells spar to evaluate, resolve, and dispatch the next
                task — see "What smart mode does" above.
              </p>
            )}
          </section>

          {/* Needs human */}
          <section className="border-b border-neutral-800 px-3 py-3">
            <div className="flex items-center justify-between">
              <SectionLabel>Needs human</SectionLabel>
              {needsHumanLoading && (
                <Loader2 className="h-3 w-3 animate-spin text-neutral-500" />
              )}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-neutral-500">
              {autopilot
                ? "Items smart mode flagged for your judgment."
                : "Smart mode tags items here when it can't act on them alone."}
            </p>
            <NeedsHumanList items={needsHuman} loading={needsHumanLoading} />
          </section>

          {/* Recent auto-reports */}
          <section className="px-3 py-3">
            <SectionLabel>Recent auto-reports</SectionLabel>
            <p className="mt-1 text-[11px] leading-snug text-neutral-500">
              Last few terminal completions that triggered an auto-report.
            </p>
            <RecentDispatchList items={completedDispatches} />
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
          </div>
          <p className="mt-1 line-clamp-3 text-xs text-neutral-200">{r.body}</p>
        </li>
      ))}
    </ul>
  );
}

interface DispatchSummary {
  id: string;
  projectId: string;
  prompt: string;
  completedAt: number | null;
}

function RecentDispatchList({ items }: { items: DispatchSummary[] }) {
  if (items.length === 0) {
    return (
      <p className="mt-2 text-xs italic text-neutral-500">
        No completed dispatches yet.
      </p>
    );
  }
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {items.map((d) => (
        <li
          key={d.id}
          className="rounded-md border border-neutral-800 bg-neutral-900/40 p-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[10px] uppercase tracking-wider text-neutral-500">
              {d.projectId}
            </span>
            <span className="text-[10px] text-neutral-600">
              {formatRelative(d.completedAt ?? 0)}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-neutral-300">
            {d.prompt}
          </p>
        </li>
      ))}
    </ul>
  );
}

function formatRelative(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
