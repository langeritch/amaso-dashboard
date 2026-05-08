"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";

/**
 * Install page hero. The companion now ships as a "paste this into
 * Claude Code" flow rather than a DMG: the prompt clones the repo,
 * installs deps, launches the Electron app, and walks the user
 * through sign-in. The DMG path is still available behind a
 * disclosure for anyone without Claude Code on their Mac.
 *
 * The prompt always pulls latest from main, so there's no version
 * label on this page — a published version number would just go
 * stale.
 */
const SETUP_PROMPT = `Set up the Amaso Companion on this Mac. It's a small Electron menu-bar app that connects this machine to https://dashboard.amaso.nl over a WebSocket so the dashboard can run local actions here: shell commands, file reads, screenshots, GUI input, and voice via the Spar window.

Steps:

1. Clone the repo into ~/Desktop/Projects/amaso-companion if it isn't there yet, otherwise pull latest:
   if [ -d ~/Desktop/Projects/amaso-companion ]; then
     cd ~/Desktop/Projects/amaso-companion && git pull --ff-only origin main
   else
     git clone https://github.com/langeritch/amaso-dashboard.git ~/Desktop/Projects/amaso-companion
   fi

2. cd into the electron subdirectory and install deps:
   cd ~/Desktop/Projects/amaso-companion/electron && npm install --no-audit --no-fund

3. Launch the companion in the background and leave it running:
   nohup npx electron . > /tmp/amaso-companion.log 2>&1 &
   disown

4. Verify the tray icon appears in the macOS menu bar. Click it. Sign in with your Amaso dashboard email and password.

5. macOS will prompt for microphone access on first launch (the companion uses it for voice activity detection so it can duck other audio while you talk to Spar). Click Allow.

6. After sign-in, the tray icon flips to its connected variant and the companion appears in the dashboard's connected-devices list under Settings.

Keep the launched process alive in the background. To update later, just re-run me with the same prompt.

If anything fails (missing node, mic denied, port conflict, signed-in but tray says offline), report exactly what failed and stop. Do not invent fixes.`;

export default function InstallApp() {
  return (
    <div className="flex flex-col gap-6">
      <PromptHero />
      <Steps />
      <DmgFallback />
    </div>
  );
}

function PromptHero() {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const onCopy = useCallback(async () => {
    try {
      // navigator.clipboard isn't available on http or in some embedded
      // browsers. Fall back to a hidden textarea + execCommand so the
      // copy still works under those constraints.
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(SETUP_PROMPT);
      } else {
        const ta = document.createElement("textarea");
        ta.value = SETUP_PROMPT;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, 2000);
    } catch {
      /* clipboard rejected — leave the button label alone */
    }
  }, []);

  return (
    <section className="relative overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950 shadow-[0_4px_24px_rgba(0,0,0,0.35)]">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy setup prompt"
        className={`amaso-fx amaso-press absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
          copied
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            : "border-neutral-700 bg-neutral-900/80 text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800"
        }`}
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5" />
            <span>Copied</span>
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" />
            <span>Copy</span>
          </>
        )}
      </button>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-5 py-6 pr-24 font-mono text-[12.5px] leading-relaxed text-neutral-200 sm:px-7 sm:py-7 sm:text-[13px]">
        {SETUP_PROMPT}
      </pre>
    </section>
  );
}

function Steps() {
  const steps = [
    "Open Claude Code on your Mac (claude.ai/code or the CLI).",
    "Paste the prompt above and hit enter.",
    "Sign in to the companion when its menu-bar icon prompts you.",
  ];
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step, i) => (
        <li
          key={i}
          className="flex items-start gap-3 rounded-lg border border-neutral-800/60 bg-neutral-950/40 px-4 py-3"
        >
          <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-orange-600/20 text-xs font-semibold text-orange-300">
            {i + 1}
          </span>
          <p className="text-sm text-neutral-300">{step}</p>
        </li>
      ))}
    </ol>
  );
}

function DmgFallback() {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group rounded-lg border border-neutral-800/60 bg-neutral-950/40"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="amaso-fx amaso-press flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-neutral-300 hover:bg-neutral-900/40 [&::-webkit-details-marker]:hidden">
        <span>Don&rsquo;t have Claude Code?</span>
        <ChevronDown
          className={`h-4 w-4 flex-shrink-0 text-neutral-500 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </summary>
      <div className="flex flex-col gap-1 border-t border-neutral-800/60 px-4 py-3 text-sm">
        <a
          href="/api/companion/latest-release"
          className="text-neutral-300 underline-offset-2 hover:text-neutral-100 hover:underline"
        >
          Download the unsigned DMG (advanced users)
        </a>
        <p className="text-xs text-neutral-500">
          Requires manually clearing Gatekeeper quarantine. Not the
          recommended path.
        </p>
      </div>
    </details>
  );
}
