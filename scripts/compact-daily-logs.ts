#!/usr/bin/env tsx
/**
 * Topic-aware daily-log decay runner (Smart Topic System Layer 7).
 *
 * Usage:
 *   npm run compact-daily-logs                # real run, all users
 *   npm run compact-daily-logs -- --dry-run   # plan-only, no writes
 *   npm run compact-daily-logs -- --user santi
 *
 * Default behaviour is WRITE — the spec is explicit on this. Use
 * --dry-run when you want to audit which files would change.
 *
 * Exit codes:
 *   0  success (may include per-section errors recorded in stdout)
 *   1  fatal error (couldn't even start)
 *   2  bad arguments
 */

import { compactDailyLogs } from "../lib/daily-log-compaction";
import { getDb } from "../lib/db";

interface Args {
  dryRun: boolean;
  userArg: string | null;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let userArg: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "--dryrun") {
      dryRun = true;
    } else if (a === "--user" && argv[i + 1]) {
      userArg = argv[++i];
    } else if (a.startsWith("--user=")) {
      userArg = a.slice("--user=".length);
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return { dryRun, userArg };
}

function printUsage(): void {
  console.error(
    "usage: tsx scripts/compact-daily-logs.ts [--dry-run] [--user <name|id>]",
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
  const { dryRun, userArg } = parseArgs(process.argv.slice(2));
  let userIds: number[] | undefined;
  if (userArg) {
    const id = resolveUserId(userArg);
    if (id === null) {
      console.error(`no user found for --user=${userArg}`);
      process.exit(2);
    }
    userIds = [id];
  }
  try {
    const summary = await compactDailyLogs({ dryRun, userIds });
    console.log("");
    console.log("=== Daily-log compaction summary ===");
    console.log(`  scanned             ${summary.scanned}`);
    console.log(`  would-change        ${summary.wouldChange}`);
    console.log(`  wrote               ${summary.wrote}`);
    console.log(`  skipped: current-w  ${summary.skippedCurrentWeek}`);
    console.log(`  skipped: at-target  ${summary.skippedAlready}`);
    console.log(`  topic-preserved     ${summary.topicPreservedFiles}`);
    console.log(`  errored             ${summary.errored}`);
    if (dryRun) console.log("  (dry-run — no brain files were touched)");
    if (summary.files.some((f) => f.sectionErrors.length > 0)) {
      console.log("");
      console.log("Per-file errors:");
      for (const f of summary.files) {
        if (f.sectionErrors.length === 0) continue;
        console.log(`  ${f.plan.relPath}`);
        for (const e of f.sectionErrors) {
          console.log(`    [${e.heading}] ${e.error}`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[compact] fatal: ${msg}`);
    process.exit(1);
  }
}

main();
