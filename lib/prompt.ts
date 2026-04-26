// Builds the prompt that Claude CLI receives when an admin clicks
// "Fix alle openstaande". The goal: give Claude enough context to make
// correct code changes to the NEVA17 (or any other) project, without
// needing to query the dashboard further.
//
// Attachments (screenshots) are referenced by absolute path so Claude can
// read them directly with its Read tool (jpg/png/pdf are all supported).

import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { getProject } from "./config";

export interface PromptRemarkRow {
  id: number;
  path: string | null;
  line: number | null;
  column: number | null;
  category: string;
  body: string;
  context: unknown;
  author: string;
  created_at: number;
  attachments: { id: number; filename: string; storage_key: string }[];
}

export function loadOpenRemarks(projectId: string): PromptRemarkRow[] {
  const rows = getDb()
    .prepare(
      `SELECT r.id, r.path, r.line, r."column", r.category, r.body, r.context,
              r.created_at, u.name AS author
         FROM remarks r JOIN users u ON u.id = r.user_id
        WHERE r.project_id = ? AND r.resolved_at IS NULL
        ORDER BY r.created_at ASC`,
    )
    .all(projectId) as Array<
    Omit<PromptRemarkRow, "context" | "attachments"> & {
      context: string | null;
    }
  >;

  const ids = rows.map((r) => r.id);
  const attachmentsByRemark = new Map<
    number,
    PromptRemarkRow["attachments"]
  >();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const attRows = getDb()
      .prepare(
        `SELECT id, remark_id, filename, storage_key
           FROM remark_attachments WHERE remark_id IN (${placeholders})
          ORDER BY id ASC`,
      )
      .all(...ids) as {
      id: number;
      remark_id: number;
      filename: string;
      storage_key: string;
    }[];
    for (const a of attRows) {
      const arr = attachmentsByRemark.get(a.remark_id) ?? [];
      arr.push({ id: a.id, filename: a.filename, storage_key: a.storage_key });
      attachmentsByRemark.set(a.remark_id, arr);
    }
  }

  return rows.map((r) => ({
    ...r,
    context: r.context ? safeJson(r.context) : null,
    attachments: attachmentsByRemark.get(r.id) ?? [],
  }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Absolute path to an attachment file on disk. Used so Claude can read
 * screenshots directly via its Read tool.
 */
export function attachmentAbsPath(
  remarkId: number,
  storageKey: string,
): string {
  return path.resolve(
    process.cwd(),
    "data",
    "remarks",
    String(remarkId),
    storageKey,
  );
}

export interface BuiltPrompt {
  prompt: string;
  /** Remark IDs included — so we can mark them resolved after. */
  remarkIds: number[];
  projectRoot: string;
}

export function buildFixAllPrompt(projectId: string): BuiltPrompt | null {
  const project = getProject(projectId);
  if (!project) return null;
  const remarks = loadOpenRemarks(projectId);
  if (remarks.length === 0) return null;

  const parts: string[] = [];
  parts.push(
    `You are helping me fix a list of ${remarks.length} open remarks on my local Nuxt project "${project.name}" at \`${project.path}\`.`,
  );
  parts.push("");
  parts.push("**Ground rules:**");
  parts.push(
    "- Treat this as a LOCAL-ONLY session. Edit files directly in the working directory. Do NOT create git commits, do NOT push, do NOT open PRs.",
  );
  parts.push(
    "- My Syncthing keeps the folder in sync with my Mac and my Nuxt dev server is live on http://localhost:1717 — edits will hot-reload so I can review.",
  );
  parts.push(
    "- Preserve the existing code style (Vue 3 Composition API, TypeScript, Tailwind). No unrelated refactors.",
  );
  parts.push(
    "- If a remark is ambiguous, make the smallest reasonable change and mention what you assumed in your summary.",
  );
  parts.push(
    "- If a remark references a screenshot, use your Read tool on the attachment path to see what the user means.",
  );
  parts.push("");
  parts.push(`**Working directory:** \`${project.path}\``);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(`## The ${remarks.length} open remarks`);
  parts.push("");

  for (const r of remarks) {
    const when = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
    const where = r.path
      ? `\`${r.path}${r.line ? `:${r.line}` : ""}\``
      : "(project-level — no specific file)";
    parts.push(`### Remark #${r.id} · ${r.category} · by ${r.author} · ${when}`);
    parts.push(`**Target:** ${where}`);
    parts.push("");
    parts.push("> " + r.body.replace(/\n/g, "\n> "));
    parts.push("");
    // Inspector context (tag/classes/locator etc) if we have it
    if (r.context && typeof r.context === "object") {
      const ctx = r.context as Record<string, unknown>;
      const lines: string[] = [];
      if (ctx.tag) lines.push(`  - tag: \`<${String(ctx.tag)}>\``);
      if (ctx.id) lines.push(`  - id: \`#${String(ctx.id)}\``);
      if (Array.isArray(ctx.classes) && ctx.classes.length > 0) {
        lines.push(`  - classes: \`${(ctx.classes as string[]).join(" ")}\``);
      }
      if (ctx.locator) lines.push(`  - DOM path: \`${String(ctx.locator)}\``);
      if (ctx.text) {
        const t = String(ctx.text);
        lines.push(
          `  - text snippet: "${t.length > 200 ? t.slice(0, 200) + "…" : t}"`,
        );
      }
      if (ctx.pageUrl) lines.push(`  - page: ${String(ctx.pageUrl)}`);
      if (lines.length > 0) {
        parts.push("**Element context from the live preview:**");
        parts.push(...lines);
        parts.push("");
      }
      if (typeof ctx.outerHtml === "string" && ctx.outerHtml.length > 0) {
        parts.push("**Rendered HTML excerpt:**");
        parts.push("```html");
        parts.push(String(ctx.outerHtml));
        parts.push("```");
        parts.push("");
      }
    }
    if (r.attachments.length > 0) {
      parts.push("**Attachments (read these with your Read tool):**");
      for (const a of r.attachments) {
        // Skip non-existent files defensively
        const abs = attachmentAbsPath(r.id, a.storage_key);
        if (fs.existsSync(abs)) {
          parts.push(`  - \`${abs}\` (${a.filename})`);
        }
      }
      parts.push("");
    }
    parts.push("---");
    parts.push("");
  }

  parts.push("## What I want you to do");
  parts.push("");
  parts.push(
    "Work through every remark above. For each one, read the relevant file(s), make the change, and move on. When you're finished:",
  );
  parts.push("");
  parts.push("1. Summarise each remark with a one-line status: **fixed**, **partial**, or **skipped** (with a short reason).");
  parts.push("2. List every file you modified.");
  parts.push(
    "3. Do NOT run git commands. Do NOT start/stop dev servers. Just edit files.",
  );
  parts.push("");
  parts.push("Thanks — go.");

  return {
    prompt: parts.join("\n"),
    remarkIds: remarks.map((r) => r.id),
    projectRoot: project.path,
  };
}

export function markResolved(remarkIds: number[]) {
  if (remarkIds.length === 0) return;
  const stmt = getDb().prepare(
    "UPDATE remarks SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL",
  );
  const now = Date.now();
  const tx = getDb().transaction((ids: number[]) => {
    for (const id of ids) stmt.run(now, id);
  });
  tx(remarkIds);
}
