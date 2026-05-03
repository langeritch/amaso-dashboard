// Open remarks tagged "needs-human" across every project the current
// user can see. Drives the autopilot sidebar's needs-human panel: the
// autonomous loop tags remarks it can't execute (financial details,
// external accounts, real-people contact, business judgment) so the
// human can sweep them in one place.

import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RemarkRow {
  id: number;
  project_id: string;
  body: string;
  tags: string | null;
  created_at: number;
  user_name: string;
}

interface NeedsHumanRemark {
  id: number;
  projectId: string;
  body: string;
  tags: string[];
  createdAt: number;
  author: string;
}

export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const projects = visibleProjects(auth.user);
  if (projects.length === 0) return NextResponse.json({ remarks: [] });

  const placeholders = projects.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT r.id, r.project_id, r.body, r.tags, r.created_at,
              u.name AS user_name
         FROM remarks r JOIN users u ON u.id = r.user_id
        WHERE r.resolved_at IS NULL
          AND r.project_id IN (${placeholders})
          AND r.tags IS NOT NULL
        ORDER BY r.created_at DESC
        LIMIT 200`,
    )
    .all(...projects.map((p) => p.id)) as RemarkRow[];

  const remarks: NeedsHumanRemark[] = [];
  for (const row of rows) {
    const tags = parseTags(row.tags);
    if (!tags.some((t) => t.toLowerCase() === "needs-human")) continue;
    remarks.push({
      id: row.id,
      projectId: row.project_id,
      body: row.body,
      tags,
      createdAt: row.created_at,
      author: row.user_name,
    });
  }
  return NextResponse.json({ remarks });
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}
