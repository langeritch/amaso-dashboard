/**
 * Layer 6.5 — tense-aware recall hint detector.
 *
 * The detector is a pure regex pipeline. Tests cover:
 *   - Positive: present-perfect / past-perfect constructions that
 *     reference earlier conversation context.
 *   - Negative: idiomatic perfect tense ("I've got coffee"), polite
 *     hedges ("I've a feeling"), interrogatives ("have you eaten"),
 *     and weather ("has it been raining") all skip.
 *   - Keyword extraction: proper nouns win; otherwise the longest
 *     non-stopword survives.
 *   - Hint block rendering: contains the matched phrase + the
 *     suggested keyword in a recall() call template.
 *
 * No DB writes — the route owns audit logging, the detector is pure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectTenseHint, buildTenseHintBlock } from "../lib/spar-tense-hints.js";

describe("detectTenseHint — positive cases", () => {
  test("I've been struggling with X", () => {
    const h = detectTenseHint("I've been struggling with pricing all week.");
    assert.ok(h, "should fire");
    assert.match(h!.matchedPhrase.toLowerCase(), /i'?ve been struggling/);
    assert.equal(h!.suggestedKeyword?.toLowerCase(), "pricing");
  });

  test("we've decided on pricing", () => {
    const h = detectTenseHint("So we've decided on pricing for the landing page.");
    assert.ok(h);
    assert.match(h!.matchedPhrase.toLowerCase(), /we'?ve decided/);
  });

  test("had finished + past participle continuation", () => {
    const h = detectTenseHint("By Friday we had finished the Outlook automation.");
    assert.ok(h);
    assert.match(h!.matchedPhrase.toLowerCase(), /had finished/);
  });

  test("have been + verb-ing", () => {
    const h = detectTenseHint("They have been working on the audit since Monday.");
    assert.ok(h);
  });

  test("we've been talking about HyET", () => {
    const h = detectTenseHint("We've been talking about HyET again.");
    assert.ok(h);
    // Proper-noun extraction should pick up "HyET".
    assert.equal(h!.suggestedKeyword, "HyET");
  });
});

describe("detectTenseHint — negative cases (reject list)", () => {
  test("I've got coffee", () => {
    assert.equal(detectTenseHint("I've got coffee, just woke up."), null);
  });

  test("Have you eaten?", () => {
    assert.equal(detectTenseHint("Have you eaten yet?"), null);
  });

  test("I've a question", () => {
    assert.equal(detectTenseHint("I've a question about the install flow."), null);
  });

  test("Has it been raining all morning?", () => {
    assert.equal(detectTenseHint("Has it been raining all morning?"), null);
  });

  test("empty / too short", () => {
    assert.equal(detectTenseHint(""), null);
    assert.equal(detectTenseHint("hi"), null);
  });

  test("no perfect tense at all", () => {
    assert.equal(
      detectTenseHint("Let's start a new project for the landing page."),
      null,
    );
  });
});

describe("detectTenseHint — keyword extraction", () => {
  test("prefers proper nouns", () => {
    const h = detectTenseHint(
      "We've decided to go ahead with Noah on the new flow.",
    );
    assert.ok(h);
    assert.equal(h!.suggestedKeyword, "Noah");
  });

  test("falls back to longest non-stopword", () => {
    const h = detectTenseHint("I've been thinking about reimbursement amounts.");
    assert.ok(h);
    // Both "thinking" and "about" are stopwords; "reimbursement" or "amounts" should win.
    assert.ok(
      ["reimbursement", "amounts"].includes((h!.suggestedKeyword ?? "").toLowerCase()),
      `got: ${h!.suggestedKeyword}`,
    );
  });

  test("returns null keyword when there's nothing usable after the trigger", () => {
    const h = detectTenseHint("We've decided.");
    assert.ok(h);
    assert.equal(h!.suggestedKeyword, null);
  });
});

describe("buildTenseHintBlock", () => {
  test("contains matched phrase + recall call template", () => {
    const block = buildTenseHintBlock({
      matchedPhrase: "we've decided",
      suggestedKeyword: "pricing",
      context: "we've decided on pricing",
    });
    assert.match(block, /we'?ve decided/);
    assert.match(block, /recall\(\{type:'keyword', value:'pricing'\}\)/);
    assert.match(block, /Tense hint/);
  });

  test("falls back gracefully when no keyword", () => {
    const block = buildTenseHintBlock({
      matchedPhrase: "we've decided",
      suggestedKeyword: null,
      context: "we've decided",
    });
    assert.match(block, /noun from the surrounding sentence/i);
    assert.doesNotMatch(block, /value:'null'/);
  });
});
