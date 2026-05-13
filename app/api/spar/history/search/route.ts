/**
 * Layer 5 — full-text history search.
 *
 * GET /api/spar/history/search?q=<query>[&user=<id|name>][&limit=<n>]
 *
 * Searches across the user's:
 *   - spar_messages.content (joined through daily_chats so each hit
 *     gets attributed to a local date).
 *   - extracted_facts.fact (the per-fact rows persisted by Layer 4).
 *
 * Results are grouped by date_local, newest first. Each hit carries a
 * 200-char snippet centred on the match, with the matched substring
 * wrapped in `<mark>…</mark>` so the client can render it without
 * re-implementing the highlight math. v1 uses SQLite LIKE; FTS is a
 * future drop-in once message-corpus size warrants it.
 *
 * Scoping:
 *   - Non-admin callers ignore &user= and always search their own
 *     corpus.
 *   - Admin callers may pass &user= to search another user.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MessageHit {
  id: number;
  conversationId: number;
  role: string;
  createdAt: number;
  date: string;
  snippet: string;
}

interface FactHit {
  id: number;
  date: string;
  classification: string;
  brainFile: string;
  section: string;
  snippet: string;
}

interface DayBucket {
  date: string;
  messages: MessageHit[];
  facts: FactHit[];
}

const SNIPPET_RADIUS = 80; // chars around the match
const SNIPPET_MAX = 240;

function resolveTargetUser(
  callerId: number,
  callerRole: string,
  rawUser: string | null,
): number | null {
  if (!rawUser || callerRole !== "admin") return callerId;
  const asNum = Number(rawUser);
  const db = getDb();
  if (Number.isFinite(asNum) && asNum > 0) {
    const row = db.prepare("SELECT id FROM users WHERE id = ?").get(asNum) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }
  const row = db
    .prepare("SELECT id FROM users WHERE LOWER(name) = LOWER(?)")
    .get(rawUser) as { id: number } | undefined;
  return row?.id ?? null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildSnippet(text: string, query: string): string {
  if (!text || !query) return "";
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) {
    // Defensive: shouldn't happen since LIKE already filtered, but
    // tolerate stray rows and return the head of the text.
    return escapeHtml(text.slice(0, SNIPPET_MAX));
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS);
  const before = text.slice(start, idx);
  const hit = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  // Collapse whitespace inside the snippet so the UI doesn't get
  // stuck rendering a multi-line dump.
  const flat = (s: string) => s.replace(/\s+/g, " ");
  return (
    prefix +
    escapeHtml(flat(before)) +
    "<mark>" +
    escapeHtml(flat(hit)) +
    "</mark>" +
    escapeHtml(flat(after)) +
    suffix
  );
}

export async function GET(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  // Empty query returns nothing rather than the whole corpus —
  // callers display a "type to search" empty state.
  if (q.length < 2) {
    return NextResponse.json({
      query: q,
      buckets: [],
      totalMessages: 0,
      totalFacts: 0,
    });
  }
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
    300,
  );
  const targetUserId = resolveTargetUser(
    auth.user.id,
    auth.user.role,
    url.searchParams.get("user"),
  );
  if (targetUserId === null) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 });
  }

  const db = getDb();
  const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const messageRows = db
    .prepare(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
              dc.date_local AS date
         FROM spar_messages m
         JOIN daily_chats dc ON dc.conversation_id = m.conversation_id
        WHERE dc.user_id = ?
          AND m.role IN ('user','assistant')
          AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .all(targetUserId, like, limit) as Array<{
    id: number;
    conversation_id: number;
    role: string;
    content: string;
    created_at: number;
    date: string;
  }>;

  const factRows = db
    .prepare(
      `SELECT id, date, fact, classification, brain_file, section
         FROM extracted_facts
        WHERE user_id = ? AND fact LIKE ? ESCAPE '\\'
        ORDER BY date DESC, id DESC
        LIMIT ?`,
    )
    .all(targetUserId, like, limit) as Array<{
    id: number;
    date: string;
    fact: string;
    classification: string;
    brain_file: string;
    section: string;
  }>;

  const buckets = new Map<string, DayBucket>();
  const bucket = (date: string): DayBucket => {
    let b = buckets.get(date);
    if (!b) {
      b = { date, messages: [], facts: [] };
      buckets.set(date, b);
    }
    return b;
  };

  for (const r of messageRows) {
    bucket(r.date).messages.push({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      createdAt: r.created_at,
      date: r.date,
      snippet: buildSnippet(r.content, q),
    });
  }
  for (const r of factRows) {
    bucket(r.date).facts.push({
      id: r.id,
      date: r.date,
      classification: r.classification,
      brainFile: r.brain_file,
      section: r.section,
      snippet: buildSnippet(r.fact, q),
    });
  }

  const ordered = Array.from(buckets.values()).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );

  return NextResponse.json({
    query: q,
    buckets: ordered,
    totalMessages: messageRows.length,
    totalFacts: factRows.length,
  });
}
