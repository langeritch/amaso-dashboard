// Claude account switcher.
//
// Manages multiple Claude identities so the operator can flip the dashboard
// between accounts (personal, client, dev sandbox, ...) without restarting.
// Two distinct things ride on top of an "account":
//
//   1. CLI login — the spawned `claude.exe` reads its OAuth/API token from
//      `<CLAUDE_CONFIG_DIR>/.credentials.json`. By giving each account its
//      own dir, we route every fresh `claude` spawn through the active
//      account's credentials. Default for the CLI is `~/.claude`; we set
//      CLAUDE_CONFIG_DIR explicitly on every spawn so the override always
//      wins regardless of inherited env.
//
//   2. Direct API key — used only by the Python `telegram-voice` sidecar
//      today (no @anthropic-ai/sdk consumers exist in the Node dashboard).
//      `getActiveApiKey()` returns the active account's key, falling back to
//      `process.env.ANTHROPIC_API_KEY` when no accounts are configured.
//
// Storage lives in `amaso.config.json` so it survives dashboard restarts and
// shows up in version control reviews. API keys are stored unencrypted —
// this is a single-user local box, not a shared server.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeAccount {
  id: string;
  name: string;
  /**
   * Filesystem dir the CLI reads with `CLAUDE_CONFIG_DIR=<dir>`. Must
   * contain a `.credentials.json` for the CLI to authenticate; everything
   * else (settings.json, projects/, ...) is per-account too. The "default"
   * account points at `~/.claude` directly so existing brain memory and
   * settings keep working without migration.
   */
  credentialsDir: string;
  /**
   * Optional Anthropic API key for direct SDK consumers (telegram-voice
   * inbound calls today; future Anthropic SDK calls). Null = fall back to
   * process.env.ANTHROPIC_API_KEY.
   */
  apiKey: string | null;
}

interface AccountsBlock {
  claudeAccounts?: ClaudeAccount[];
  activeClaudeAccountId?: string | null;
}

const CONFIG_PATH = path.resolve(process.cwd(), "amaso.config.json");

const DEFAULT_HOME_CLAUDE = path
  .join(os.homedir(), ".claude")
  .replace(/\\/g, "/");

/** Root for non-default accounts' per-account config dirs. */
function accountsRoot(): string {
  return path
    .join(os.homedir(), ".amaso", "claude-accounts")
    .replace(/\\/g, "/");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readConfigRaw(): Record<string, unknown> {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeConfigRaw(parsed: Record<string, unknown>): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

function readBlock(): AccountsBlock {
  try {
    const cfg = readConfigRaw() as Record<string, unknown> & AccountsBlock;
    return {
      claudeAccounts: Array.isArray(cfg.claudeAccounts)
        ? (cfg.claudeAccounts as ClaudeAccount[])
        : undefined,
      activeClaudeAccountId:
        typeof cfg.activeClaudeAccountId === "string"
          ? (cfg.activeClaudeAccountId as string)
          : null,
    };
  } catch {
    return { claudeAccounts: undefined, activeClaudeAccountId: null };
  }
}

/** All accounts. Returns an empty array when the feature has never been
 *  used (no `claudeAccounts` key in config). Callers that need a default
 *  account materialised should call `ensureDefaultAccount()` first. */
export function listAccounts(): ClaudeAccount[] {
  return readBlock().claudeAccounts ?? [];
}

/** Active account, or null when no accounts are configured at all. */
export function getActiveAccount(): ClaudeAccount | null {
  const block = readBlock();
  const accounts = block.claudeAccounts ?? [];
  if (accounts.length === 0) return null;
  if (block.activeClaudeAccountId) {
    const found = accounts.find((a) => a.id === block.activeClaudeAccountId);
    if (found) return found;
  }
  return accounts[0] ?? null;
}

/** True when an account has been configured. The spawn paths use this to
 *  decide whether to inject CLAUDE_CONFIG_DIR — pre-feature behaviour
 *  (no env override) is preserved when this returns false. */
export function isFeatureActive(): boolean {
  return listAccounts().length > 0;
}

/** Env overrides to merge into a child process spawn that uses the Claude
 *  CLI. Returns an empty object when no account is active so the caller
 *  can spread unconditionally. */
export function spawnEnvOverrides(): Record<string, string> {
  const account = getActiveAccount();
  if (!account) return {};
  return {
    CLAUDE_CONFIG_DIR: account.credentialsDir,
  };
}

/** Active API key for SDK consumers (telegram-voice today). Falls back to
 *  the original env var so existing setups without account config keep
 *  working. */
export function getActiveApiKey(): string | undefined {
  const account = getActiveAccount();
  if (account?.apiKey) return account.apiKey;
  return process.env.ANTHROPIC_API_KEY;
}

function genId(): string {
  // 8 hex chars is plenty — accounts are scoped to one machine and listed
  // in a UI that shows the human-friendly name. Not a security boundary.
  return Math.random().toString(16).slice(2, 10);
}

function writeAccountsBlock(accounts: ClaudeAccount[], activeId: string | null): void {
  const parsed = readConfigRaw();
  parsed.claudeAccounts = accounts;
  parsed.activeClaudeAccountId = activeId;
  writeConfigRaw(parsed);
}

/**
 * Materialise a "default" account on first use. Captures the current
 * `~/.claude/.credentials.json` (if any) by pointing the account at the
 * existing dir — no copy. This means the default account literally IS the
 * pre-feature state, so enabling the feature is non-destructive.
 *
 * Returns the default account. Idempotent.
 */
export function ensureDefaultAccount(): ClaudeAccount {
  const accounts = listAccounts();
  const existingDefault = accounts.find((a) => a.id === "default");
  if (existingDefault) return existingDefault;

  const def: ClaudeAccount = {
    id: "default",
    name: "Default (~/.claude)",
    credentialsDir: DEFAULT_HOME_CLAUDE,
    apiKey: null,
  };
  const next = [def, ...accounts];
  const block = readBlock();
  writeAccountsBlock(next, block.activeClaudeAccountId ?? "default");
  return def;
}

export interface AddAccountInput {
  name: string;
  /** When true, copy the current `~/.claude/.credentials.json` into a
   *  fresh dir for the new account. Convenient when the operator just
   *  ran `claude /login` interactively and wants to capture that session.
   *  If false, `credentialsJson` is required. */
  captureFromDefault?: boolean;
  /** Raw credentials JSON to drop into the new account's dir. */
  credentialsJson?: string;
  apiKey?: string | null;
}

export interface AddAccountResult {
  account: ClaudeAccount;
}

/** Persist a new account. Creates the on-disk credentials dir and writes
 *  `.credentials.json`. Throws on validation failure with a code the
 *  caller can map to an HTTP status. */
export function addAccount(input: AddAccountInput): AddAccountResult {
  const name = input.name?.trim();
  if (!name) throw new Error("missing_name");
  const accounts = listAccounts();
  if (accounts.some((a) => a.name === name)) {
    throw new Error("duplicate_name");
  }

  const id = genId();
  const dir = path.join(accountsRoot(), id).replace(/\\/g, "/");
  ensureDir(dir);

  let credsJson: string | null = null;
  if (input.captureFromDefault) {
    const src = path.join(DEFAULT_HOME_CLAUDE, ".credentials.json");
    if (!fs.existsSync(src)) {
      throw new Error("default_credentials_missing");
    }
    credsJson = fs.readFileSync(src, "utf8");
  } else if (input.credentialsJson?.trim()) {
    // Validate it parses — surfacing JSON errors here is much friendlier
    // than letting the CLI silently fail to authenticate later.
    try {
      JSON.parse(input.credentialsJson);
    } catch {
      throw new Error("invalid_credentials_json");
    }
    credsJson = input.credentialsJson;
  } else {
    throw new Error("missing_credentials");
  }

  fs.writeFileSync(path.join(dir, ".credentials.json"), credsJson, {
    encoding: "utf8",
    mode: 0o600,
  });

  const account: ClaudeAccount = {
    id,
    name,
    credentialsDir: dir,
    apiKey: input.apiKey?.trim() ? input.apiKey.trim() : null,
  };

  // Make sure the default account exists too so the user can flip back.
  ensureDefaultAccount();
  const next = [...listAccounts(), account];
  const block = readBlock();
  writeAccountsBlock(next, block.activeClaudeAccountId ?? "default");
  return { account };
}

/** Register an account whose `.credentials.json` was already written
 *  to `dir` by an external flow (in practice: the OAuth PTY session
 *  in lib/claude-oauth-sessions.ts). Unlike addAccount, this does NOT
 *  copy or write the credentials — `dir` becomes the account's
 *  permanent `credentialsDir` as-is. The OAuth flow is responsible
 *  for choosing a unique dir up front (typically inside
 *  ~/.amaso/claude-accounts/<id>/) so account ids and dir names line
 *  up. Throws on duplicate name; on missing/invalid credentials in
 *  the dir; or on a name collision with an existing account.
 */
export function registerAccountFromCredentialsDir(input: {
  name: string;
  credentialsDir: string;
}): ClaudeAccount {
  const name = input.name?.trim();
  if (!name) throw new Error("missing_name");
  const dir = input.credentialsDir.replace(/\\/g, "/");
  const credPath = path.join(dir, ".credentials.json");
  if (!fs.existsSync(credPath)) {
    throw new Error("credentials_missing");
  }
  // Sanity-check the JSON parses — if the OAuth flow wrote garbage
  // we'd rather fail here than at first CLI use.
  try {
    JSON.parse(fs.readFileSync(credPath, "utf8"));
  } catch {
    throw new Error("invalid_credentials_json");
  }

  const accounts = listAccounts();
  // De-duplicate by name with a numeric suffix rather than rejecting
  // — the OAuth flow auto-generates names ("Account 2026-05-02 19:30")
  // and a second sign-in in the same minute should still succeed.
  let finalName = name;
  let suffix = 2;
  while (accounts.some((a) => a.name === finalName)) {
    finalName = `${name} (${suffix++})`;
  }

  // Derive id from the dir name when it lives under accountsRoot — this
  // keeps the on-disk dir name matching the account.id. For dirs outside
  // that tree (operator pointed at a custom path), generate a fresh id.
  const root = path.join(os.homedir(), ".amaso", "claude-accounts").replace(/\\/g, "/");
  let id: string;
  if (dir.startsWith(root + "/")) {
    id = dir.slice(root.length + 1).split("/")[0]!;
    // If somehow that id is already in use (race with another concurrent
    // OAuth flow), generate fresh.
    if (accounts.some((a) => a.id === id) || id === "default") {
      id = genId();
    }
  } else {
    id = genId();
  }

  const account: ClaudeAccount = {
    id,
    name: finalName,
    credentialsDir: dir,
    apiKey: null,
  };

  ensureDefaultAccount();
  const next = [...listAccounts(), account];
  const block = readBlock();
  writeAccountsBlock(next, block.activeClaudeAccountId ?? "default");
  return account;
}

/** Switch which account is "active" — the one every subsequent CLI spawn
 *  + SDK call uses. Returns the new active account. */
export function setActiveAccount(id: string): ClaudeAccount {
  const accounts = listAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new Error("account_not_found");
  writeAccountsBlock(accounts, id);
  return account;
}

export interface UpdateAccountInput {
  name?: string;
  apiKey?: string | null;
}

export function updateAccount(id: string, input: UpdateAccountInput): ClaudeAccount {
  const accounts = listAccounts();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error("account_not_found");
  const updated: ClaudeAccount = { ...accounts[idx]! };
  if (typeof input.name === "string" && input.name.trim()) {
    const newName = input.name.trim();
    if (accounts.some((a) => a.id !== id && a.name === newName)) {
      throw new Error("duplicate_name");
    }
    updated.name = newName;
  }
  if (input.apiKey === null) {
    updated.apiKey = null;
  } else if (typeof input.apiKey === "string") {
    updated.apiKey = input.apiKey.trim() ? input.apiKey.trim() : null;
  }
  accounts[idx] = updated;
  const block = readBlock();
  writeAccountsBlock(accounts, block.activeClaudeAccountId ?? null);
  return updated;
}

export function removeAccount(id: string): void {
  if (id === "default") throw new Error("cannot_remove_default");
  const accounts = listAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new Error("account_not_found");
  const next = accounts.filter((a) => a.id !== id);

  const block = readBlock();
  let newActive = block.activeClaudeAccountId ?? null;
  if (newActive === id) {
    // Fall back to default — guaranteed to exist because we materialise
    // it on every add. If the user somehow removed default too, fall
    // through to the first surviving account.
    newActive = next.find((a) => a.id === "default")?.id ?? next[0]?.id ?? null;
  }
  writeAccountsBlock(next, newActive);

  // Best-effort filesystem cleanup. A leftover dir isn't dangerous (the
  // CLI never reads it again) so we don't escalate failures.
  try {
    if (
      account.credentialsDir &&
      account.credentialsDir.startsWith(accountsRoot())
    ) {
      fs.rmSync(account.credentialsDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

/** Public-facing view that masks the API key to the last 4 chars so the
 *  list endpoint can return account state without leaking secrets to
 *  whoever has dashboard read access. */
export interface ClaudeAccountView {
  id: string;
  name: string;
  credentialsDir: string;
  apiKeyMasked: string | null;
  active: boolean;
}

export function viewAccounts(): ClaudeAccountView[] {
  const block = readBlock();
  const accounts = block.claudeAccounts ?? [];
  const activeId = block.activeClaudeAccountId ?? null;
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    credentialsDir: a.credentialsDir,
    apiKeyMasked: a.apiKey
      ? `••••${a.apiKey.slice(-4)}`
      : null,
    active: a.id === activeId,
  }));
}
