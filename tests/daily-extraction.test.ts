/**
 * Layer 4 — post-day fact extraction tests.
 *
 * Brain writes go to a per-suite tmp dir via the `brainRoot` option on
 * extractDailyFacts, so production brain files are never touched.
 * Anthropic calls are stubbed via the `extractor` injection point so
 * no network I/O is involved.
 *
 * The DB used is the live data/amaso.db (same posture as
 * tests/brain-acl + tests/daily-chat). A disposable user + daily-chat
 * conversation + messages are seeded per suite and torn down after.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDb } from "../lib/db.js";
import {
  extractDailyFacts,
  parseExtractorResponse,
  VALID_CLASSIFICATIONS,
} from "../lib/daily-extraction.js";

const TMP_BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "extract-test-"));

const TEST_DATE = "2026-04-30";
const TEST_EMAIL = `extract-test-${Date.now()}@local.invalid`;
const TEST_USER_NAME = "ExtractTester";
const SLUG = "extracttester";

let userId = 0;
let conversationId = 0;
const messageIds: number[] = [];

before(() => {
  const db = getDb();
  const now = Date.now();
  const userInfo = db
    .prepare(
      "INSERT INTO users (email, password, name, role, created_at) VALUES (?, '', ?, 'team', ?)",
    )
    .run(TEST_EMAIL, TEST_USER_NAME, now);
  userId = Number(userInfo.lastInsertRowid);

  const convInfo = db
    .prepare(
      "INSERT INTO spar_conversations (user_id, title, created_at, updated_at, task_id) VALUES (?, NULL, ?, ?, NULL)",
    )
    .run(userId, now, now);
  conversationId = Number(convInfo.lastInsertRowid);

  db.prepare(
    "INSERT INTO daily_chats (user_id, date_local, conversation_id, active, created_at) VALUES (?, ?, ?, 1, ?)",
  ).run(userId, TEST_DATE, conversationId, now);

  const transcript: Array<["user" | "assistant", string]> = [
    ["user", "I decided to use Postgres instead of SQLite for the new marketing app."],
    ["assistant", "Solid call. Postgres handles concurrent writes better."],
    ["user", "Noah and I agreed to ship the landing page redesign by Friday."],
    ["assistant", "Got it — Friday deadline locked in with Noah."],
    ["user", "Mom's birthday is on May 18, don't let me forget."],
  ];
  let t = now - 3 * 60 * 60 * 1000;
  for (const [role, content] of transcript) {
    const r = db
      .prepare(
        "INSERT INTO spar_messages (conversation_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, NULL, ?)",
      )
      .run(conversationId, role, content, t);
    messageIds.push(Number(r.lastInsertRowid));
    t += 30 * 1000;
  }
});

after(() => {
  const db = getDb();
  // FK cascade from users handles spar_conversations + daily_chats +
  // daily_extractions; spar_messages drops with its conversation.
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  try {
    fs.rmSync(TMP_BRAIN, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Pure parser: JSON validation + allowlist rejection
// ---------------------------------------------------------------------------

describe("parseExtractorResponse", () => {
  const allowlist = new Set([
    `users/${SLUG}/profile.md`,
    `users/${SLUG}/calendar.md`,
    "projects.md",
    "decisions.md",
  ]);

  test("parses a valid array", () => {
    const raw = JSON.stringify([
      {
        fact: "User prefers Postgres over SQLite for new projects.",
        classification: "preferences",
        brain_file: `users/${SLUG}/profile.md`,
        section: "Workflow",
        source_message_ids: [1, 2],
      },
    ]);
    const out = parseExtractorResponse(raw, allowlist);
    assert.equal(out.error, null);
    assert.equal(out.facts.length, 1);
    assert.equal(out.rejected, 0);
  });

  test("strips a markdown code fence", () => {
    const raw = "```json\n[]\n```";
    const out = parseExtractorResponse(raw, allowlist);
    assert.equal(out.error, null);
    assert.equal(out.facts.length, 0);
  });

  test("rejects facts whose classification isn't in the enum", () => {
    const raw = JSON.stringify([
      {
        fact: "Bogus",
        classification: "made-up-category",
        brain_file: `users/${SLUG}/profile.md`,
        section: "Identity",
        source_message_ids: [1],
      },
    ]);
    const out = parseExtractorResponse(raw, allowlist);
    assert.equal(out.facts.length, 0);
    assert.equal(out.rejected, 1);
  });

  test("rejects facts whose brain_file is outside the allowlist", () => {
    const raw = JSON.stringify([
      {
        fact: "Trying to escape",
        classification: "preferences",
        brain_file: "users/santi/profile.md", // wrong slug for this user
        section: "Identity",
        source_message_ids: [1],
      },
    ]);
    const out = parseExtractorResponse(raw, allowlist);
    assert.equal(out.facts.length, 0);
    assert.equal(out.rejected, 1);
  });

  test("returns an error string when the response is unparseable", () => {
    const out = parseExtractorResponse("not json at all", allowlist);
    assert.notEqual(out.error, null);
  });
});

// ---------------------------------------------------------------------------
// Integration: full pipeline with a stubbed extractor
// ---------------------------------------------------------------------------

describe("extractDailyFacts — full pipeline with stub", () => {
  test("writes facts to the correct brain files + persists daily_extractions row", async () => {
    const stub = async () =>
      JSON.stringify([
        {
          fact: "User decided to use Postgres instead of SQLite for the new marketing app.",
          classification: "decisions",
          brain_file: "decisions.md",
          section: "Switched marketing app to Postgres",
          source_message_ids: [messageIds[0]],
        },
        {
          fact: "Mom's birthday is on May 18.",
          classification: "calendar",
          brain_file: `users/${SLUG}/calendar.md`,
          section: "Birthdays",
          source_message_ids: [messageIds[4]],
        },
        {
          fact: "Landing page redesign committed for Friday with Noah.",
          classification: "goals",
          brain_file: "goals.md",
          section: "This week",
          source_message_ids: [messageIds[2], messageIds[3]],
        },
        {
          fact: "Garbage: tried to write outside the allowlist.",
          classification: "decisions",
          brain_file: "../etc/passwd",
          section: "Hack",
          source_message_ids: [],
        },
      ]);

    const result = await extractDailyFacts({
      userId,
      date: TEST_DATE,
      brainRoot: TMP_BRAIN,
      extractor: stub,
      logger: () => undefined,
    });

    assert.equal(result.status, "success");
    assert.equal(result.factCount, 3, "3 valid facts kept");
    assert.equal(result.factsRejected, 1, "the path-escape attempt was rejected");
    assert.deepEqual(
      Object.keys(result.classifications).sort(),
      ["calendar", "decisions", "goals"],
    );
    assert.equal(result.filesWritten.includes("decisions.md"), true);
    assert.equal(
      result.filesWritten.includes(`users/${SLUG}/calendar.md`),
      true,
    );
    assert.equal(result.filesWritten.includes("goals.md"), true);

    const decisions = await fsp.readFile(
      path.join(TMP_BRAIN, "decisions.md"),
      "utf8",
    );
    assert.match(decisions, /## Switched marketing app to Postgres/);
    assert.match(decisions, /Postgres instead of SQLite/);
    assert.match(decisions, new RegExp(`extracted from daily chat ${TEST_DATE}`));
    const cal = await fsp.readFile(
      path.join(TMP_BRAIN, `users/${SLUG}/calendar.md`),
      "utf8",
    );
    assert.match(cal, /## Birthdays/);
    assert.match(cal, /Mom's birthday/);

    const db = getDb();
    const row = db
      .prepare(
        "SELECT status, fact_count, classifications_json FROM daily_extractions WHERE user_id = ? AND date = ?",
      )
      .get(userId, TEST_DATE) as
      | { status: string; fact_count: number; classifications_json: string }
      | undefined;
    assert.ok(row, "row exists");
    assert.equal(row!.status, "success");
    assert.equal(row!.fact_count, 3);
    const breakdown = JSON.parse(row!.classifications_json) as Record<
      string,
      number
    >;
    assert.equal(breakdown.decisions, 1);
    assert.equal(breakdown.calendar, 1);
    assert.equal(breakdown.goals, 1);
  });

  test("rerun without --force is skipped", async () => {
    const stub = async () => "[]";
    const result = await extractDailyFacts({
      userId,
      date: TEST_DATE,
      brainRoot: TMP_BRAIN,
      extractor: stub,
      logger: () => undefined,
    });
    assert.equal(result.status, "skipped");
  });

  test("rerun with --force re-checks facts; duplicates are no-ops via fingerprint", async () => {
    const stub = async () =>
      JSON.stringify([
        {
          fact: "User decided to use Postgres instead of SQLite for the new marketing app.",
          classification: "decisions",
          brain_file: "decisions.md",
          section: "Switched marketing app to Postgres",
          source_message_ids: [messageIds[0]],
        },
      ]);
    const result = await extractDailyFacts({
      userId,
      date: TEST_DATE,
      force: true,
      brainRoot: TMP_BRAIN,
      extractor: stub,
      logger: () => undefined,
    });
    assert.equal(result.status, "success");
    assert.equal(result.factsSkippedDuplicate, 1);
    assert.equal(result.filesWritten.length, 0);
  });

  test("dry-run does not touch brain files or daily_extractions row state", async () => {
    const db = getDb();
    const otherDate = "2026-04-29";
    const convInfo = db
      .prepare(
        "INSERT INTO spar_conversations (user_id, title, created_at, updated_at, task_id) VALUES (?, NULL, ?, ?, NULL)",
      )
      .run(userId, Date.now(), Date.now());
    const convId = Number(convInfo.lastInsertRowid);
    db.prepare(
      "INSERT INTO daily_chats (user_id, date_local, conversation_id, active, created_at) VALUES (?, ?, ?, 1, ?)",
    ).run(userId, otherDate, convId, Date.now());
    db.prepare(
      "INSERT INTO spar_messages (conversation_id, role, content, tool_calls, created_at) VALUES (?, 'user', 'something durable here', NULL, ?)",
    ).run(convId, Date.now());

    const stub = async () =>
      JSON.stringify([
        {
          fact: "Some new durable fact for dry-run.",
          classification: "lessons",
          brain_file: "lessons.md",
          section: "Lesson Snippet",
          source_message_ids: [],
        },
      ]);

    const result = await extractDailyFacts({
      userId,
      date: otherDate,
      dryRun: true,
      brainRoot: TMP_BRAIN,
      extractor: stub,
      logger: () => undefined,
    });

    assert.equal(result.status, "success");
    assert.equal(result.factCount, 1);
    const lessonsExists = fs.existsSync(path.join(TMP_BRAIN, "lessons.md"));
    assert.equal(lessonsExists, false);
    const row = db
      .prepare(
        "SELECT 1 FROM daily_extractions WHERE user_id = ? AND date = ?",
      )
      .get(userId, otherDate);
    assert.equal(row, undefined);
  });

  test("classifier enum stays in lockstep with the prompt", () => {
    const expected = new Set([
      "identity",
      "psychology",
      "preferences",
      "calendar",
      "projects",
      "decisions",
      "lessons",
      "goals",
      "timeline",
      "people",
      "daily-log-summary",
    ]);
    assert.equal(VALID_CLASSIFICATIONS.size, expected.size);
    for (const k of expected) {
      assert.ok(VALID_CLASSIFICATIONS.has(k as never), `enum is missing ${k}`);
    }
  });
});
