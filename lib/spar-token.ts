// One-time-use-ish tokens minted per spar CLI invocation so the MCP server
// subprocess can call back into the dashboard without leaking permanent
// credentials. Tokens carry the userId so tool handlers run with the
// correct identity (access checks, heartbeat ownership, etc.).

import crypto from "node:crypto";

const TTL_MS = 10 * 60 * 1000; // 10 minutes — plenty for an agent loop

interface TokenRow {
  userId: number;
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoSparTokens: Map<string, TokenRow> | undefined;
}

function store(): Map<string, TokenRow> {
  if (!globalThis.__amasoSparTokens) globalThis.__amasoSparTokens = new Map();
  return globalThis.__amasoSparTokens;
}

function sweep(): void {
  const now = Date.now();
  const s = store();
  for (const [tok, row] of s) {
    if (row.expiresAt <= now) s.delete(tok);
  }
}

export function mintToken(userId: number): string {
  sweep();
  const token = crypto.randomBytes(32).toString("base64url");
  store().set(token, { userId, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function validateToken(token: string): number | null {
  const row = store().get(token);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    store().delete(token);
    return null;
  }
  return row.userId;
}

export function revokeToken(token: string): void {
  store().delete(token);
}
