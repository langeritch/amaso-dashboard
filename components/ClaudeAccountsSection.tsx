"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";

interface ClaudeAccountView {
  id: string;
  name: string;
  credentialsDir: string;
  apiKeyMasked: string | null;
  active: boolean;
}

type OAuthStatus =
  | "spawning"
  | "awaiting_url"
  | "awaiting_code"
  | "exchanging"
  | "done"
  | "failed"
  | "cancelled";

interface OAuthSessionView {
  id: string;
  status: OAuthStatus;
  authUrl: string | null;
  recentOutput: string;
  error: string | null;
  accountId: string | null;
  startedAt: number;
}

export default function ClaudeAccountsSection() {
  const [accounts, setAccounts] = useState<ClaudeAccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [oauth, setOauth] = useState<OAuthSessionView | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/claude-accounts", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { accounts: ClaudeAccountView[] };
      setAccounts(data.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function activate(id: string) {
    setBusyId(id);
    try {
      const res = await fetch("/api/claude-accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { accounts: ClaudeAccountView[] };
      setAccounts(data.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "switch_failed");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this account? Its stored credentials will be deleted.")) {
      return;
    }
    setBusyId(id);
    try {
      const res = await fetch(`/api/claude-accounts/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { accounts: ClaudeAccountView[] };
      setAccounts(data.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete_failed");
    } finally {
      setBusyId(null);
    }
  }

  async function startOAuth() {
    setError(null);
    try {
      const res = await fetch("/api/claude-accounts/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { session: OAuthSessionView };
      setOauth(data.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "oauth_start_failed");
    }
  }

  async function cancelOAuth() {
    if (!oauth) return;
    try {
      await fetch(`/api/claude-accounts/authorize/${oauth.id}`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort */
    }
    setOauth(null);
  }

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/60">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Claude accounts
        </h2>
        {!oauth && (
          <button
            type="button"
            onClick={startOAuth}
            className="amaso-fx amaso-press flex items-center gap-1 rounded-md border border-orange-500/40 bg-orange-500/15 px-2.5 py-1 text-xs font-medium text-orange-200 hover:border-orange-400/60 hover:bg-orange-500/25"
          >
            <Plus className="h-3 w-3" /> Add account
          </button>
        )}
      </div>

      <p className="px-4 pb-3 text-xs text-neutral-500">
        Switching the active account routes every freshly-spawned{" "}
        <code className="rounded bg-neutral-900 px-1 text-[11px]">claude</code>{" "}
        CLI through that account&rsquo;s credentials, and updates the API key
        used by the inbound Telegram-voice loop. Existing terminal sessions
        keep their old login until they&rsquo;re restarted.
      </p>

      {error && (
        <div className="mx-4 mb-3 rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      {oauth && (
        <OAuthFlow
          initial={oauth}
          onDone={(session) => {
            setOauth(null);
            void refresh();
            if (session.accountId) {
              // Fire-and-forget — auto-activate the freshly-added account
              // since that's almost always why the user added it.
              void activate(session.accountId);
            }
          }}
          onCancel={() => void cancelOAuth()}
          onError={(msg) => setError(msg)}
        />
      )}

      <div className="flex flex-col">
        {accounts === null && (
          <div className="flex items-center gap-2 px-4 py-4 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
          </div>
        )}
        {accounts?.length === 0 && (
          <div className="px-4 py-4 text-sm text-neutral-500">
            No accounts yet. Click <strong>Add account</strong> to sign into
            your first one.
          </div>
        )}
        {accounts?.map((a, i) => (
          <AccountRow
            key={a.id}
            account={a}
            busy={busyId === a.id}
            isFirst={i === 0}
            onActivate={() => activate(a.id)}
            onRemove={() => remove(a.id)}
          />
        ))}
      </div>
    </section>
  );
}

function AccountRow({
  account,
  busy,
  isFirst,
  onActivate,
  onRemove,
}: {
  account: ClaudeAccountView;
  busy: boolean;
  isFirst: boolean;
  onActivate: () => void;
  onRemove: () => void;
}) {
  const canRemove = account.id !== "default";
  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 ${
        isFirst ? "" : "border-t border-neutral-800"
      } ${account.active ? "bg-neutral-900/40" : ""}`}
    >
      <button
        type="button"
        onClick={onActivate}
        disabled={busy || account.active}
        className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition ${
          account.active
            ? "border-orange-500 bg-orange-500/20"
            : "border-neutral-700 hover:border-neutral-500"
        } disabled:cursor-default disabled:opacity-60`}
        aria-label={account.active ? "Active account" : "Switch to this account"}
        title={account.active ? "Active" : "Switch to this account"}
      >
        {account.active && (
          <span className="block h-2 w-2 rounded-full bg-orange-400" />
        )}
        {busy && !account.active && (
          <Loader2 className="h-3 w-3 animate-spin text-neutral-400" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-neutral-200">{account.name}</span>
          {account.active && (
            <span className="rounded-full border border-orange-700/60 bg-orange-900/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-orange-300">
              Active
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-neutral-500">
          {account.credentialsDir}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-neutral-500">
          <KeyRound className="h-3 w-3" />
          <span>
            {account.apiKeyMasked
              ? `API key ${account.apiKeyMasked}`
              : "No API key (uses ANTHROPIC_API_KEY env)"}
          </span>
        </div>
      </div>

      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-900 hover:text-red-400 disabled:opacity-50"
          aria-label="Remove account"
          title="Remove account"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function OAuthFlow({
  initial,
  onDone,
  onCancel,
  onError,
}: {
  initial: OAuthSessionView;
  onDone: (session: OAuthSessionView) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const [session, setSession] = useState<OAuthSessionView>(initial);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  // Poll session status every second. Stop once we've reached a terminal
  // state (done / failed / cancelled). Includes a sanity timeout so a
  // server-side hang doesn't leave the UI spinning forever.
  useEffect(() => {
    if (
      session.status === "done" ||
      session.status === "failed" ||
      session.status === "cancelled"
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(
          `/api/claude-accounts/authorize/${session.id}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (res.status === 404) {
            // Session vanished — treat as cancelled.
            if (!cancelled) {
              setSession((s) => ({ ...s, status: "cancelled" as const }));
              window.clearInterval(timer);
            }
            return;
          }
          return;
        }
        const data = (await res.json()) as { session: OAuthSessionView };
        if (!cancelled) setSession(data.session);
      } catch {
        /* transient — next tick will retry */
      }
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session.id, session.status]);

  // Auto-focus the code input as soon as the URL appears so the user
  // can paste immediately on returning from the browser.
  useEffect(() => {
    if (session.status === "awaiting_code") {
      codeInputRef.current?.focus();
    }
  }, [session.status]);

  // Surface successful completion to the parent so the account list can
  // refresh and the freshly-added account auto-activates.
  useEffect(() => {
    if (session.status === "done") {
      onDone(session);
    }
    if (session.status === "failed" && session.error) {
      onError(session.error);
    }
  }, [session.status, session.error, session, onDone, onError]);

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/claude-accounts/authorize/${session.id}/code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code.trim() }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { session: OAuthSessionView };
      setSession(data.session);
      setCode("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "submit_failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-4 mb-4 flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
          Sign into Anthropic
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
          aria-label="Cancel sign-in"
        >
          <X className="h-3 w-3" /> Cancel
        </button>
      </div>

      {session.status === "spawning" && (
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Starting Claude CLI…
        </div>
      )}

      {session.authUrl && session.status !== "done" && (
        <>
          <p className="text-xs text-neutral-400">
            We&rsquo;ve tried to open your browser. If it didn&rsquo;t pop up,
            click below — sign in, then paste the code Anthropic gives you.
          </p>
          <a
            href={session.authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-md border border-orange-700 bg-orange-900/40 px-3 py-2 text-xs text-orange-100 hover:bg-orange-900/60"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open Anthropic sign-in
          </a>

          <form onSubmit={submitCode} className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Code from the callback page
              <input
                ref={codeInputRef}
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Paste the code Anthropic gave you"
                className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                autoComplete="off"
                spellCheck={false}
                disabled={submitting || session.status === "exchanging"}
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-neutral-500">
                {session.status === "exchanging"
                  ? "Exchanging code with Anthropic…"
                  : "Press Enter to submit"}
              </span>
              <button
                type="submit"
                disabled={submitting || !code.trim() || session.status === "exchanging"}
                className="flex items-center gap-1 rounded-md border border-orange-700 bg-orange-900/40 px-3 py-1 text-xs text-orange-200 hover:bg-orange-900/60 disabled:opacity-50"
              >
                {submitting || session.status === "exchanging" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : null}
                Submit
              </button>
            </div>
          </form>
        </>
      )}

      {session.status === "done" && (
        <div className="rounded-md border border-orange-700/60 bg-orange-900/20 px-3 py-2 text-xs text-orange-200">
          Account added — switching to it now.
        </div>
      )}

      {session.status === "failed" && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {session.error ?? "Sign-in failed."}
          {session.recentOutput && (
            <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] text-red-300/80">
              {session.recentOutput}
            </pre>
          )}
        </div>
      )}

      {session.recentOutput &&
        session.status !== "failed" &&
        session.status !== "done" && (
          <details className="text-[10px] text-neutral-600">
            <summary className="cursor-pointer hover:text-neutral-400">
              CLI output
            </summary>
            <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono">
              {session.recentOutput}
            </pre>
          </details>
        )}
    </div>
  );
}
