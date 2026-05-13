#!/usr/bin/env tsx
/**
 * Smart Topic System — Layer 4 nightly extractor entry point.
 *
 * Usage:
 *   tsx scripts/extract-daily-facts.ts [--date YYYY-MM-DD] [--user <name|id>] [--force] [--dry-run]
 *
 * Defaults:
 *   --date    yesterday in Europe/Amsterdam
 *   --user    santi
 *   --force   false
 *   --dry-run false  (writes real brain files in production paths)
 *
 * Exit codes:
 *   0  success or skipped (no work to do, or already extracted)
 *   1  failed (parse error, model unreachable, etc.) — see logs/daily-extractions.log
 *   2  bad arguments / missing user
 */

import { getDb } from "../lib/db";
import {
  extractDailyFacts,
  yesterdayLocalDate,
  type ExtractionResult,
} from "../lib/daily-extraction";

interface Args {
  date: string;
  userArg: string;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let date = yesterdayLocalDate();
  let userArg = "santi";
  let force = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date" && argv[i + 1]) {
      date = argv[++i];
    } else if (a.startsWith("--date=")) {
      date = a.slice("--date=".length);
    } else if (a === "--user" && argv[i + 1]) {
      userArg = argv[++i];
    } else if (a.startsWith("--user=")) {
      userArg = a.slice("--user=".length);
    } else if (a === "--force") {
      force = true;
    } else if (a === "--dry-run" || a === "--dryrun") {
      dryRun = true;
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      // unknown flag — bail rather than guess intent
      console.error(`unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`--date must be YYYY-MM-DD, got: ${date}`);
    process.exit(2);
  }
  return { date, userArg, force, dryRun };
}

function printUsage(): void {
  console.error(
    "usage: tsx scripts/extract-daily-facts.ts [--date YYYY-MM-DD] [--user <name|id>] [--force] [--dry-run]",
  );
}

function resolveUserId(userArg: string): number | null {
  const db = getDb();
  const asNum = Number(userArg);
  if (Number.isFinite(asNum) && asNum > 0) {
    const row = db.prepare("SELECT id FROM users WHERE id = ?").get(asNum) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }
  const row = db
    .prepare("SELECT id FROM users WHERE LOWER(name) = LOWER(?)")
    .get(userArg) as { id: number } | undefined;
  return row?.id ?? null;
}

async function main(): Promise<void> {
  const { date, userArg, force, dryRun } = parseArgs(process.argv.slice(2));
  const userId = resolveUserId(userArg);
  if (userId === null) {
    console.error(`no user found for --user=${userArg}`);
    process.exit(2);
  }

  let result: ExtractionResult;
  try {
    result = await extractDailyFacts({ userId, date, force, dryRun });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract] fatal: ${msg}`);
    process.exit(1);
  }

  // Human-readable summary on stdout (the log line also lands in
  // logs/daily-extractions.log via the library's logger).
  console.log("");
  console.log("=== Daily extraction result ===");
  console.log(`  user        ${userId}`);
  console.log(`  date        ${date}`);
  console.log(`  status      ${result.status}`);
  console.log(`  facts       ${result.factCount}`);
  console.log(`  dup-skipped ${result.factsSkippedDuplicate}`);
  console.log(`  rejected    ${result.factsRejected}`);
  if (Object.keys(result.classifications).length > 0) {
    console.log("  breakdown:");
    for (const [k, v] of Object.entries(result.classifications).sort()) {
      console.log(`    ${k.padEnd(20)} ${v}`);
    }
  }
  if (result.filesWritten.length > 0) {
    console.log("  files-written:");
    for (const f of result.filesWritten) console.log(`    ${f}`);
  }
  if (result.errorText) {
    console.log(`  error       ${result.errorText}`);
  }
  if (dryRun) console.log("  (dry-run — no brain files or DB rows touched)");

  if (result.status === "failed") process.exit(1);
  process.exit(0);
}

main();
