/**
 * Layer 6 — recall tool tests.
 *
 * Three modes: date, topic, keyword. Each exercised against a seeded
 * fixture user with two days of synthetic transcript + a topic with
 * cross-day attachments + two extracted facts that mention the
 * keyword. Also verifies the recall_invocations audit row is written
 * when skipAudit is false, and skipped when it's true.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../lib/db.js";
import { recall } from "../lib/spar-recall.js";

const TEST_EMAIL = `recall-test-${Date.now()}@local.invalid`;
const TEST_USER_NAME = "RecallTester";

const DATE_A = "2026-04-21";
const DATE_B = "2026-04-22";

let userId = 0;
let conversationA = 0;
let conversationB = 0;
let topicId = 0;
let extractionAId = 0;
let extractionBId = 0;
let msgWithHyetId = 0;

before(() => {
  const db = getDb();
  const now = Date.now();
  const u = db
    .prepare(
      "INSERT INTO users (email, password, name, role, created_at) VALUES (?, '', ?, 'team', ?)",
    )
    .run(TEST_EMAIL, TEST_USER_NAME, now);
  userId = Number(u.lastInsertRowid);

  const makeConv = (date: string): number => {
    const c = db
      .prepare(
        "INSERT INTO spar_conversations (user_id, title, created_at, updated_at, task_id) VALUES (?, NULL, ?, ?, NULL)",
      )
      .run(userId, now, now);
    const id = Number(c.lastInsertRowid);
    db.prepare(
      "INSERT INTO daily_chats (user_id, date_local, conversation_id, active, created_at) VALUES (?, ?, ?, 1, ?)",
    ).run(userId, date, id, now);
    return id;
  };
  conversationA = makeConv(DATE_A);
  conversationB = makeConv(DATE_B);

  // Day A: HyET pricing mention + a tool-irrelevant turn.
  const addMsg = (
    convId: number,
    role: "user" | "assistant",
    content: string,
    ts: number,
  ): number => {
    const r = db
      .prepare(
        "INSERT INTO spar_messages (conversation_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, NULL, ?)",
      )
      .run(convId, role, content, ts);
    return Number(r.lastInsertRowid);
  };
  const tA0 = now - 5 * 24 * 60 * 60 * 1000;
  const msgA1 = addMsg(conversationA, "user", "Yassine quoted HyET pricing at 2400 euro for the dashboard work.", tA0);
  msgWithHyetId = msgA1;
  addMsg(conversationA, "assistant", "Noted — HyET at 2400. Want me to draft a counter?", tA0 + 1000);
  addMsg(conversationA, "user", "Reminder: dentist on Friday at 10am.", tA0 + 2000);

  // Day B: HyET again + a different topic message. Both HyET turns
  // mention the substring verbatim so keyword-search counts are
  // predictable.
  const tB0 = now - 4 * 24 * 60 * 60 * 1000;
  addMsg(conversationB, "user", "HyET came back — they'll do it for 2100. Lock it in.", tB0);
  addMsg(conversationB, "assistant", "HyET locked in at 2100. Final scope?", tB0 + 1000);
  addMsg(conversationB, "user", "Lunch at La Strada was decent.", tB0 + 2000);

  // Topic spanning both days: tag HyET messages.
  const t = db
    .prepare(
      "INSERT INTO topics (user_id, slug, title, status, created_at, updated_at, last_active_at, message_count) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)",
    )
    .run(userId, "hyet-pricing", "HyET pricing", now, now, now, 3);
  topicId = Number(t.lastInsertRowid);
  // Attach via spar_message_topics on day-A messages (msgA1 + assistant)
  // and day-B's first two messages.
  const allHyetMsgs = db
    .prepare(
      `SELECT id FROM spar_messages WHERE conversation_id IN (?, ?) AND content LIKE '%HyET%' ORDER BY id ASC`,
    )
    .all(conversationA, conversationB) as Array<{ id: number }>;
  const attach = db.prepare(
    "INSERT OR IGNORE INTO spar_message_topics (topic_id, message_id, relevance, created_at) VALUES (?, ?, 1.0, ?)",
  );
  for (const m of allHyetMsgs) attach.run(topicId, m.id, now);

  // Seed parent daily_extractions rows + one fact per day mentioning HyET.
  const insExtraction = db.prepare(
    `INSERT INTO daily_extractions
       (user_id, date, run_at, status, fact_count, classifications_json, source_message_ids)
     VALUES (?, ?, ?, 'success', ?, '{}', '[]')`,
  );
  const a = insExtraction.run(userId, DATE_A, now, 1);
  extractionAId = Number(a.lastInsertRowid);
  const b = insExtraction.run(userId, DATE_B, now, 1);
  extractionBId = Number(b.lastInsertRowid);

  const insFact = db.prepare(
    `INSERT INTO extracted_facts
       (extraction_id, user_id, date, fact, classification, brain_file, section, source_message_ids, created_at)
     VALUES (?, ?, ?, ?, 'people', 'people.md', ?, '[]', ?)`,
  );
  insFact.run(
    extractionAId,
    userId,
    DATE_A,
    "Yassine quoted HyET work at 2400 euro on " + DATE_A + ".",
    "Yassine",
    now,
  );
  insFact.run(
    extractionBId,
    userId,
    DATE_B,
    "HyET pricing locked in at 2100 euro after counter.",
    "HyET",
    now,
  );
});

after(() => {
  const db = getDb();
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
});

describe("recall — type='date'", () => {
  test("loads that day's full transcript + extracted facts", () => {
    const result = recall({
      userId,
      type: "date",
      value: DATE_A,
      skipAudit: true,
    });
    assert.equal(result.query.type, "date");
    assert.equal(result.query.value, DATE_A);
    assert.equal(result.results.length, 1, "one bucket for one day");
    const bucket = result.results[0]!;
    assert.equal(bucket.date, DATE_A);
    assert.equal(bucket.messages.length, 3);
    assert.equal(bucket.facts.length, 1);
    assert.ok(bucket.facts[0]!.fact.includes("Yassine"));
  });

  test("rejects non-YYYY-MM-DD value", () => {
    assert.throws(
      () =>
        recall({
          userId,
          type: "date",
          value: "sometime last week",
          skipAudit: true,
        }),
      /YYYY-MM-DD/,
    );
  });
});

describe("recall — type='topic'", () => {
  test("loads cross-day messages by topic slug", () => {
    const result = recall({
      userId,
      type: "topic",
      value: "hyet-pricing",
      skipAudit: true,
    });
    assert.equal(result.results.length, 2, "buckets for two days");
    const totalMsgs = result.results.reduce((n, b) => n + b.messages.length, 0);
    assert.equal(totalMsgs, 4, "two messages per day matched the topic");
    // Facts that mention 'hyet' as keyword should also surface.
    const totalFacts = result.results.reduce((n, b) => n + b.facts.length, 0);
    assert.ok(totalFacts >= 1);
  });

  test("partial title match resolves to the topic", () => {
    const result = recall({
      userId,
      type: "topic",
      value: "HyET",
      skipAudit: true,
    });
    assert.equal(result.query.value, "hyet-pricing", "resolved to slug");
    assert.ok(result.totalMessages >= 4);
  });

  test("unknown topic returns empty without throwing", () => {
    const result = recall({
      userId,
      type: "topic",
      value: "no-such-topic-here",
      skipAudit: true,
    });
    assert.equal(result.results.length, 0);
    assert.equal(result.totalMessages, 0);
  });
});

describe("recall — type='keyword'", () => {
  test("finds HyET mentions across both days", () => {
    const result = recall({
      userId,
      type: "keyword",
      value: "HyET",
      skipAudit: true,
    });
    // Two days touched HyET → two buckets.
    assert.equal(result.results.length, 2);
    // Facts also mention HyET in both days.
    const totalFacts = result.results.reduce((n, b) => n + b.facts.length, 0);
    assert.equal(totalFacts, 2);
    assert.ok(result.totalMessages >= 4);
  });

  test("respects the limit ceiling", () => {
    const result = recall({
      userId,
      type: "keyword",
      value: "HyET",
      limit: 2,
      skipAudit: true,
    });
    const total = result.results.reduce((n, b) => n + b.messages.length, 0);
    assert.ok(total <= 2);
    const truncatedBuckets = result.results.filter((b) => b.truncated);
    assert.ok(truncatedBuckets.length >= 1);
  });
});

describe("recall — audit logging", () => {
  test("writes a recall_invocations row when skipAudit is false", () => {
    const db = getDb();
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM recall_invocations WHERE user_id = ?")
      .get(userId) as { n: number };
    recall({ userId, type: "keyword", value: "Strada" });
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM recall_invocations WHERE user_id = ?")
      .get(userId) as { n: number };
    assert.equal(after.n, before.n + 1);
    const last = db
      .prepare(
        "SELECT type, value, total_messages, total_facts FROM recall_invocations WHERE user_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(userId) as {
      type: string;
      value: string;
      total_messages: number;
      total_facts: number;
    };
    assert.equal(last.type, "keyword");
    assert.equal(last.value, "Strada");
  });

  test("does not write when skipAudit=true", () => {
    const db = getDb();
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM recall_invocations WHERE user_id = ?")
      .get(userId) as { n: number };
    recall({ userId, type: "keyword", value: "HyET", skipAudit: true });
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM recall_invocations WHERE user_id = ?")
      .get(userId) as { n: number };
    assert.equal(after.n, before.n);
  });
});

// Sanity assertions on the fixture itself so a future schema drift
// surfaces as a fixture-only failure rather than a misleading recall
// failure.
describe("recall fixture sanity", () => {
  test("seeded data is intact", () => {
    void conversationA;
    void conversationB;
    void extractionAId;
    void extractionBId;
    void msgWithHyetId;
    void topicId;
    assert.ok(userId > 0);
    assert.ok(conversationA > 0);
    assert.ok(conversationB > 0);
    assert.ok(topicId > 0);
  });
});
