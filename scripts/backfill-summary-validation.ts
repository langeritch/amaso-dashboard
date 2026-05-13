#!/usr/bin/env tsx
/**
 * Remark #431 backfill — walk every existing topic + daily_subjects
 * row, run the validator, and stamp the quality_flag accordingly.
 * Never regenerates retroactively (per spec: "Don't regenerate
 * retroactively unless trivial under 50 weak rows" — this script is
 * stamp-only; the regen loop lives in the live extractor).
 *
 * Usage:
 *   npm run backfill-summary-validation
 *   tsx scripts/backfill-summary-validation.ts [--dry-run]
 *
 * Output: per-source summary (topic vs subject) of pass/weak counts,
 * plus a single summary_validation_log row with source='backfill'.
 *
 * Idempotent: re-running is a no-op for rows that already carry a
 * quality_flag from a prior pass.
 */

import { getDb } from "../lib/db";
import {
  validateSummary,
  qualityFlag,
} from "../lib/topic-summary-validator";
import type { SubjectEntry } from "../lib/spar-subjects";

const dryRun = process.argv.includes("--dry-run");

interface TopicRow {
  id: number;
  user_id: number;
  title: string;
  slug: string;
  summary: string | null;
  quality_flag: string | null;
}

interface SubjectsRow {
  id: number;
  user_id: number;
  date: string;
  subjects: string;
}

function backfillTopics(): { total: number; pass: number; weak: number; skipped: number } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, user_id, title, slug, summary, quality_flag
         FROM topics WHERE summary IS NOT NULL AND summary != ''`,
    )
    .all() as TopicRow[];
  let pass = 0;
  let weak = 0;
  let skipped = 0;
  const upd = db.prepare("UPDATE topics SET quality_flag = ? WHERE id = ?");
  for (const r of rows) {
    if (r.quality_flag) {
      skipped++;
      continue;
    }
    const v = validateSummary(r.summary, { title: r.title, slug: r.slug });
    const flag = qualityFlag(v);
    if (flag === "pass") pass++;
    else weak++;
    if (!dryRun) upd.run(flag, r.id);
  }
  return { total: rows.length, pass, weak, skipped };
}

interface SubjectAnchor {
  title: string;
  slug: string;
}

function loadAnchors(topicIds: number[]): Map<number, SubjectAnchor> {
  const out = new Map<number, SubjectAnchor>();
  if (topicIds.length === 0) return out;
  const placeholders = topicIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, title, slug FROM topics WHERE id IN (${placeholders})`)
    .all(...topicIds) as Array<{ id: number; title: string; slug: string }>;
  for (const r of rows) out.set(r.id, { title: r.title, slug: r.slug });
  return out;
}

function backfillDailySubjects(): {
  totalRows: number;
  totalSubjects: number;
  pass: number;
  weak: number;
  skipped: number;
} {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, user_id, date, subjects FROM daily_subjects`)
    .all() as SubjectsRow[];
  const upd = db.prepare(
    "UPDATE daily_subjects SET subjects = ? WHERE id = ?",
  );

  let totalSubjects = 0;
  let pass = 0;
  let weak = 0;
  let skipped = 0;
  for (const r of rows) {
    let parsed: SubjectEntry[];
    try {
      parsed = JSON.parse(r.subjects) as SubjectEntry[];
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const allIds = Array.from(new Set(parsed.flatMap((s) => s.topic_ids ?? [])));
    const anchors = loadAnchors(allIds);
    const next: SubjectEntry[] = parsed.map((s) => {
      totalSubjects++;
      if (s.quality_flag) {
        skipped++;
        return s;
      }
      const titles = (s.topic_ids ?? [])
        .map((id) => anchors.get(id))
        .filter((a): a is SubjectAnchor => !!a);
      const v = validateSummary(s.summary, {
        title: s.label,
        aliases: titles.flatMap((t) => [t.title, t.slug]),
      });
      const flag = qualityFlag(v);
      if (flag === "pass") pass++;
      else weak++;
      return { ...s, quality_flag: flag };
    });
    if (!dryRun) upd.run(JSON.stringify(next), r.id);
  }
  return { totalRows: rows.length, totalSubjects, pass, weak, skipped };
}

function main(): void {
  console.log(`[backfill-summary-validation] dryRun=${dryRun}`);
  const t = backfillTopics();
  console.log(
    `topics:        total=${t.total}  pass=${t.pass}  weak=${t.weak}  already-flagged=${t.skipped}`,
  );
  const s = backfillDailySubjects();
  console.log(
    `daily_subjects: rows=${s.totalRows}  subjects=${s.totalSubjects}  pass=${s.pass}  weak=${s.weak}  already-flagged=${s.skipped}`,
  );

  if (!dryRun) {
    try {
      getDb()
        .prepare(
          `INSERT INTO summary_validation_log
             (ts, source, ref_id, user_id, total, passed_first,
              regenerated, passed_after_regen, remained_weak, notes)
           VALUES (?, 'backfill', NULL, NULL, ?, ?, 0, 0, ?, ?)`,
        )
        .run(
          Date.now(),
          t.total + s.totalSubjects,
          t.pass + s.pass,
          t.weak + s.weak,
          `topics_total=${t.total} subjects_total=${s.totalSubjects}`,
        );
    } catch (err) {
      console.warn(
        "[backfill-summary-validation] log insert failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  console.log("done.");
}

main();
