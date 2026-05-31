/**
 * Item 8 — unified global search (plan #257).
 *
 * GET /api/search?q=<query>[&limit=<n per source>]
 *
 * Fans out across four sources and returns a single flat result list:
 *   - remark  : remarks.body, scoped to the caller's visible projects.
 *   - brain   : brain markdown corpus (lib/brain-search, ACL-aware).
 *   - message : spar_messages.content + extracted_facts.fact for the
 *               caller (the recall layer's corpus).
 *   - file    : recent file-change events (lib/history) whose path
 *               matches, scoped to visible projects.
 *
 * Response shape (intentionally flat for a future command-palette UI):
 *   { results: [{ type, id, title, excerpt, projectId?, url? }], ... }
 *
 * Read-only. Non-clients only. Each source is wrapped so one failing
 * source never sinks the whole response — a partial result set beats a
 * 500. SQLite LIKE for now (matches the existing history/search route);
 * FTS is a future drop-in.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { getDb, publicUser } from "@/lib/db";
import { visibleProjects } from "@/lib/access";
import { searchBrain } from "@/lib/brain-search";
import { getHistory } from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ResultType = "remark" | "brain" | "message" | "file";

interface SearchResult {
  type: ResultType;
  /** Stable per-type id. Strings so file/brain (no numeric id) fit too. */
  id: string;
  title: string;
  excerpt: string;
  projectId?: string;
  url?: string;
}

const EXCERPT_RADIUS = 90;
const EXCERPT_MAX = 240;
const DEFAULT_PER_SOURCE = 20;
const MAX_PER_SOURCE = 100;

/** Plain-text excerpt centred on the first match. No HTML — the palette
 *  renders plain strings; highlighting is the client's job. Whitespace is
 *  collapsed so a multi-line body doesn't blow up the row. */
function excerpt(text: string, query: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const body = flat(text);
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return body.slice(0, EXCERPT_MAX);
  const start = Math.max(0, idx - EXCERPT_RADIUS);
  const end = Math.min(body.length, idx + query.length + EXCERPT_RADIUS);
  return (
    (start > 0 ? "…" : "") +
    body.slice(start, end) +
    (end < body.length ? "…" : "")
  );
}

/** First line / sentence of a blob, capped — used as a result title when
 *  the source has no natural title (remarks, messages, facts). */
function titleFrom(text: string, max = 80): string {
  const firstLine = text.replace(/\s+/g, " ").trim().slice(0, max * 2);
  return firstLine.length > max ? firstLine.slice(0, max - 1) + "…" : firstLine;
}

export async function GET(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  // Short-circuit: <2 chars returns an empty set (callers show a
  // "type to search" state) rather than scanning the whole corpus.
  if (q.length < 2) {
    return NextResponse.json({ query: q, results: [], counts: {} });
  }
  const perSource = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? DEFAULT_PER_SOURCE) || DEFAULT_PER_SOURCE, 1),
    MAX_PER_SOURCE,
  );

  const db = getDb();
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const user = auth.user;
  const projects = visibleProjects(user);
  const visibleIds = new Set(projects.map((p) => p.id));
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  const results: SearchResult[] = [];
  const counts: Record<ResultType, number> = {
    remark: 0,
    brain: 0,
    message: 0,
    file: 0,
  };

  // ── remarks ──────────────────────────────────────────────────────────
  // Scoped to visible projects. Open (unresolved) remarks rank above
  // resolved ones, then newest first.
  try {
    if (visibleIds.size > 0) {
      const ph = Array.from(visibleIds).map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT r.id, r.project_id, r.path, r.line, r.category, r.body,
                  r.created_at, r.resolved_at
             FROM remarks r
            WHERE r.project_id IN (${ph})
              AND r.body LIKE ? ESCAPE '\\'
            ORDER BY (r.resolved_at IS NULL) DESC, r.created_at DESC
            LIMIT ?`,
        )
        .all(...visibleIds, like, perSource) as Array<{
        id: number;
        project_id: string;
        path: string | null;
        line: number | null;
        category: string;
        body: string;
        created_at: number;
        resolved_at: number | null;
      }>;
      for (const r of rows) {
        const name = projectNameById.get(r.project_id) ?? r.project_id;
        results.push({
          type: "remark",
          id: `remark:${r.id}`,
          title: `${name}: ${titleFrom(r.body, 60)}`,
          excerpt: excerpt(r.body, q),
          projectId: r.project_id,
          // Deep-link target the palette can route to. The remarks
          // surfaces read ?project= / ?path= already.
          url: r.path
            ? `/projects/${r.project_id}?path=${encodeURIComponent(r.path)}#remark-${r.id}`
            : `/remarks?project=${r.project_id}#remark-${r.id}`,
        });
      }
      counts.remark = rows.length;
    }
  } catch (err) {
    console.warn("[search] remarks source failed:", err);
  }

  // ── brain markdown ───────────────────────────────────────────────────
  // ACL handled inside searchBrain (shared roots + own subtree; admins
  // see all). Covers users/<name>/daily/*.md, projects.md, decisions.md,
  // lessons.md, etc.
  try {
    const hits = (await searchBrain(publicUser(user), q)).slice(0, perSource);
    for (const h of hits) {
      results.push({
        type: "brain",
        id: `brain:${h.relPath}${h.section ? "#" + h.section : ""}`,
        title: h.section ? `${h.relPath} › ${h.section}` : h.relPath,
        excerpt: h.snippet.replace(/<\/?mark>/g, ""),
        url:
          `/brain?file=${encodeURIComponent(h.relPath)}` +
          (h.section ? `&section=${encodeURIComponent(h.section)}` : ""),
      });
    }
    counts.brain = hits.length;
  } catch (err) {
    console.warn("[search] brain source failed:", err);
  }

  // ── spar messages + extracted facts (recall corpus) ──────────────────
  // Scoped to the caller's own conversations / facts.
  try {
    const msgRows = db
      .prepare(
        `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
           FROM spar_messages m
           JOIN daily_chats dc ON dc.conversation_id = m.conversation_id
          WHERE dc.user_id = ?
            AND m.role IN ('user','assistant')
            AND m.content LIKE ? ESCAPE '\\'
          ORDER BY m.created_at DESC
          LIMIT ?`,
      )
      .all(user.id, like, perSource) as Array<{
      id: number;
      conversation_id: number;
      role: string;
      content: string;
      created_at: number;
    }>;
    for (const m of msgRows) {
      results.push({
        type: "message",
        id: `message:${m.id}`,
        title: `${m.role === "user" ? "You" : "Spar"}: ${titleFrom(m.content, 60)}`,
        excerpt: excerpt(m.content, q),
        url: `/spar?conversation=${m.conversation_id}#message-${m.id}`,
      });
    }
    counts.message += msgRows.length;

    const factRows = db
      .prepare(
        `SELECT id, fact, brain_file, section
           FROM extracted_facts
          WHERE user_id = ? AND fact LIKE ? ESCAPE '\\'
          ORDER BY date DESC, id DESC
          LIMIT ?`,
      )
      .all(user.id, like, perSource) as Array<{
      id: number;
      fact: string;
      brain_file: string;
      section: string;
    }>;
    for (const f of factRows) {
      results.push({
        type: "message",
        id: `fact:${f.id}`,
        title: `Fact: ${titleFrom(f.fact, 60)}`,
        excerpt: excerpt(f.fact, q),
        url:
          `/brain?file=${encodeURIComponent(f.brain_file)}` +
          (f.section ? `&section=${encodeURIComponent(f.section)}` : ""),
      });
    }
    counts.message += factRows.length;
  } catch (err) {
    console.warn("[search] message/fact source failed:", err);
  }

  // ── recent file changes ──────────────────────────────────────────────
  // In-memory bounded log per project (lib/history). Match on path; dedupe
  // to the newest event per (project, path) so a file edited 10× shows once.
  try {
    const history = getHistory();
    const ql = q.toLowerCase();
    const seen = new Set<string>();
    const fileHits: SearchResult[] = [];
    for (const p of projects) {
      for (const ev of history.recent(p.id, 100)) {
        if (ev.type === "unlink") continue;
        if (!ev.path.toLowerCase().includes(ql)) continue;
        const key = `${p.id}\0${ev.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const name = projectNameById.get(p.id) ?? p.id;
        fileHits.push({
          type: "file",
          id: `file:${p.id}:${ev.path}`,
          title: `${name}: ${ev.path}`,
          excerpt: `${ev.type} · ${new Date(ev.ts).toISOString().slice(0, 16).replace("T", " ")}`,
          projectId: p.id,
          url: `/projects/${p.id}?path=${encodeURIComponent(ev.path)}`,
        });
        if (fileHits.length >= perSource) break;
      }
      if (fileHits.length >= perSource) break;
    }
    results.push(...fileHits);
    counts.file = fileHits.length;
  } catch (err) {
    console.warn("[search] file source failed:", err);
  }

  return NextResponse.json({
    query: q,
    results,
    counts,
    total: results.length,
  });
}
