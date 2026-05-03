"use client";

import { useEffect, useState } from "react";
import {
  Apple,
  Check,
  Download,
  ExternalLink,
  MonitorDown,
  Zap,
} from "lucide-react";
import type { CompanionReleaseInfo } from "@/lib/companion-release";

/**
 * Browsers fire `beforeinstallprompt` once, then stash the event so we can
 * trigger it from a button click later. `prompt()` / `userChoice` are the
 * only two methods we actually need.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type InstallState = "unavailable" | "available" | "installed" | "prompting";

// ---------------------------------------------------------------------------
// Mac companion — NOT a full dashboard. It's a tiny menu-bar agent that
// accepts commands from the cloud dashboard (run local commands, touch
// files, duck system audio, etc.) and otherwise stays out of the way.
//
// Distribution: GitHub Releases. The DMG is built by
// .github/workflows/build-companion.yml on `companion-v*` tag pushes. The
// CompanionCard pulls the latest release through /api/companion/latest-
// release (server-cached so we don't burn the GitHub-API rate limit on
// page-load) and renders direct DMG links. If no release exists yet
// (fresh install, between tags, or API failure), the card falls back
// to a "No release available yet" state.
// ---------------------------------------------------------------------------

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mql = window.matchMedia?.("(display-mode: standalone)");
  if (mql?.matches) return true;
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

export default function InstallApp() {
  return (
    <div className="flex flex-col gap-6">
      <PwaInstallCard />
      <CompanionCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primary: PWA install — this is the dashboard.
// ---------------------------------------------------------------------------

function PwaInstallCard() {
  const [state, setState] = useState<InstallState>("unavailable");
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (detectStandalone()) {
      setState("installed");
      return;
    }

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setState("available");
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      setState("installed");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function handleInstall() {
    if (!deferredPrompt) return;
    setState("prompting");
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      setState(choice.outcome === "accepted" ? "installed" : "available");
    } catch {
      setState("available");
    } finally {
      setDeferredPrompt(null);
    }
  }

  if (state === "installed") {
    // Don't disappear silently — without this card the install page can
    // collapse to just the header on a non-Mac browser that's already
    // got the PWA, which reads as "blank page" to anyone who navigated
    // here looking for something to do.
    return (
      <section className="rounded-lg border border-orange-900/40 bg-neutral-950/60 p-5">
        <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-orange-400">
          <Check className="h-3.5 w-3.5 flex-shrink-0" />
          <span>Step 1 · Installed</span>
        </div>
        <div className="mb-1 flex items-center gap-2">
          <MonitorDown className="h-5 w-5 flex-shrink-0 text-neutral-300" />
          <h2 className="text-lg font-semibold text-neutral-100">
            Amaso Dashboard (PWA)
          </h2>
        </div>
        <p className="text-sm text-neutral-400">
          You&rsquo;re running the installed app — it auto-updates in the
          background, so there&rsquo;s nothing to do here. To reinstall on
          another device, open this page in a browser there.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-orange-900/40 bg-neutral-950/60 p-5">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-orange-400">
        <span>Step 1 · Install the app</span>
      </div>
      <div className="mb-1 flex items-center gap-2">
        <MonitorDown className="h-5 w-5 flex-shrink-0 text-neutral-300" />
        <h2 className="text-lg font-semibold text-neutral-100">
          Amaso Dashboard (PWA)
        </h2>
      </div>
      <p className="mb-4 text-sm text-neutral-400">
        The full dashboard. Runs in its own window, works offline, and
        auto-updates in the background — on Mac, Windows, iOS, Android,
        anywhere with a modern browser.
      </p>

      {state === "available" || state === "prompting" ? (
        <button
          type="button"
          onClick={handleInstall}
          disabled={state === "prompting"}
          className="inline-flex items-center gap-2 rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:bg-orange-800"
        >
          <MonitorDown className="h-4 w-4" />
          {state === "prompting" ? "Awaiting browser prompt…" : "Install app"}
        </button>
      ) : (
        <p className="text-xs text-neutral-500">
          Your browser doesn't support one-click install. In Chrome or Edge,
          look for the install icon in the address bar. On iOS Safari, tap
          Share → Add to Home Screen.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Optional: Mac menu-bar companion — small agent, not a dashboard.
//
// The DMG ships via GitHub Releases (build-companion.yml on `companion-v*`
// tag push). This card fetches the latest release through our cached
// proxy and renders direct download buttons. If no release exists, it
// shows a "No release available yet" state instead of a broken link.
// ---------------------------------------------------------------------------

type ReleaseFetch =
  | { status: "loading" }
  | { status: "ready"; release: CompanionReleaseInfo | null }
  | { status: "error" };

async function detectMacArch(): Promise<"arm64" | "x64" | "unknown"> {
  // navigator.userAgentData is the only reliable way to tell Apple
  // Silicon from Intel inside the browser — `navigator.platform`
  // returns "MacIntel" on every Mac regardless of CPU. UA-CH isn't
  // available on Safari, so this is best-effort: if we can't tell,
  // we surface both download buttons with equal prominence.
  const uaData = (navigator as unknown as {
    userAgentData?: {
      getHighEntropyValues: (
        hints: string[],
      ) => Promise<{ architecture?: string }>;
    };
  }).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const values = await uaData.getHighEntropyValues(["architecture"]);
      if (values.architecture === "arm") return "arm64";
      if (values.architecture === "x86") return "x64";
    } catch {
      /* fall through to unknown */
    }
  }
  return "unknown";
}

function CompanionCard() {
  const [fetchState, setFetchState] = useState<ReleaseFetch>({
    status: "loading",
  });
  const [arch, setArch] = useState<"arm64" | "x64" | "unknown">("unknown");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/companion/latest-release", {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setFetchState({ status: "error" });
          return;
        }
        const body = (await res.json()) as {
          release: CompanionReleaseInfo | null;
        };
        if (cancelled) return;
        setFetchState({ status: "ready", release: body.release });
      } catch {
        if (!cancelled) setFetchState({ status: "error" });
      }
    })();
    void detectMacArch().then((a) => {
      if (!cancelled) setArch(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-5">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
        <span>Optional · Mac only</span>
      </div>
      <div className="mb-1 flex items-center gap-2">
        <Apple className="h-5 w-5 flex-shrink-0 text-neutral-300" />
        <h2 className="text-lg font-semibold text-neutral-100">
          Amaso Companion for Mac
        </h2>
      </div>
      <p className="mb-3 text-sm text-neutral-400">
        A tiny helper that lives in your macOS menu bar and connects your
        computer to the dashboard. It&rsquo;s not a second dashboard —
        it unlocks things a browser can&rsquo;t do from the cloud.
      </p>

      <ul className="mb-4 flex flex-col gap-1.5 text-sm text-neutral-400">
        <li className="flex gap-2">
          <Zap className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-400" />
          Run local commands dispatched from the dashboard
        </li>
        <li className="flex gap-2">
          <Zap className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-400" />
          Reach local files and folders when the dashboard asks
        </li>
        <li className="flex gap-2">
          <Zap className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-400" />
          Duck system audio during Spar voice sessions
        </li>
      </ul>

      <CompanionDownload fetchState={fetchState} arch={arch} />
    </section>
  );
}

function CompanionDownload({
  fetchState,
  arch,
}: {
  fetchState: ReleaseFetch;
  arch: "arm64" | "x64" | "unknown";
}) {
  if (fetchState.status === "loading") {
    return (
      <div className="text-xs text-neutral-500">Checking for latest build…</div>
    );
  }

  if (fetchState.status === "error" || !fetchState.release) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        <span className="inline-flex w-fit items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-500">
          No release available yet
        </span>
        <span className="text-xs text-neutral-500 sm:flex-1 sm:pt-1.5">
          The Mac DMG ships through GitHub Releases. Once the next
          <code className="mx-1 rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-300">
            companion-v*
          </code>
          tag lands, this card auto-updates with the download.
        </span>
      </div>
    );
  }

  const { release } = fetchState;
  const arm64Url = release.arm64Url;
  const x64Url = release.x64Url;
  // Default to Apple Silicon — that's most modern Macs. If UA-CH told
  // us this is an Intel box, prefer x64. Unknown arch surfaces both at
  // equal prominence so the user picks.
  const primary = arch === "x64" && x64Url ? "x64" : arm64Url ? "arm64" : "x64";
  const primaryUrl = primary === "arm64" ? arm64Url : x64Url;
  const secondary = primary === "arm64" ? "x64" : "arm64";
  const secondaryUrl = secondary === "arm64" ? arm64Url : x64Url;

  // Edge case: a release exists but neither arch was uploaded (partial
  // CI run). Fall back to the no-release messaging — sending the user
  // to the release page directly would just dump them on a notes-only
  // page with no download buttons.
  if (!primaryUrl) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-500">
          DMG missing on latest release
        </span>
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
        >
          View release notes
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={primaryUrl}
          className="inline-flex items-center gap-2 rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white"
        >
          <Download className="h-4 w-4" />
          Download for {primary === "arm64" ? "Apple Silicon" : "Intel"}
        </a>
        {secondaryUrl && (
          <a
            href={secondaryUrl}
            className="text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
          >
            {arch === "unknown"
              ? `Or get the ${secondary === "arm64" ? "Apple Silicon" : "Intel"} build`
              : `Wrong chip? Get the ${secondary === "arm64" ? "Apple Silicon" : "Intel"} build`}
          </a>
        )}
      </div>
      <div className="flex flex-col gap-y-1 text-[11px] text-neutral-500 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        <span>
          Latest&nbsp;build:{" "}
          <a
            href={release.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
          >
            {release.tag}
            <ExternalLink className="h-3 w-3" />
          </a>
        </span>
        <span aria-hidden="true" className="hidden text-neutral-600 sm:inline">
          ·
        </span>
        <span>
          <span className="text-amber-400">Unsigned build.</span>{" "}
          First launch: right-click the app → Open → Open again to
          bypass Gatekeeper.
        </span>
      </div>
    </div>
  );
}
