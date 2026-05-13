/**
 * Tests for the topic / subject summary quality validator (#431).
 *
 * Pure-function suite — no DB, no network. Verifies the two checks
 * (name anchor + concrete detail) plus the anchor expansion that
 * lets a multi-word slug match on a single word.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateSummary,
  buildNameAnchors,
  qualityFlag,
} from "../lib/topic-summary-validator.js";

describe("validateSummary — pass cases", () => {
  test("number signal carries a long summary that mentions the title", () => {
    const r = validateSummary(
      "HyET pricing settled at 2100 euro for the dashboard work this week.",
      { title: "HyET pricing", slug: "hyet-pricing" },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.signals.includes("number"));
  });

  test("proper noun + date is enough concrete detail", () => {
    const r = validateSummary(
      "Marketing app migration discussed with Noah; we'll cut over on Friday.",
      { title: "Marketing app migration" },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.signals.includes("proper-noun"));
    assert.ok(r.signals.includes("date"));
  });

  test("verb-noun decision phrase counts as concrete", () => {
    const r = validateSummary(
      "Decided on the woonklasse pricing tiers; will draft a landing page next.",
      { title: "woonklasse pricing", slug: "woonklasse-pricing" },
    );
    assert.equal(r.ok, true);
    assert.ok(r.signals.includes("verb-noun"));
  });

  test("slug split lets a single-word match anchor a two-word title", () => {
    // Title is two words, summary only mentions "pricing".
    const r = validateSummary(
      "Pricing locked in at 2100 euro for the dashboard work this week.",
      { title: "HyET pricing", slug: "hyet-pricing" },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe("validateSummary — fail cases", () => {
  test("empty / null / whitespace", () => {
    for (const v of ["", " ", "\n\t", null, undefined]) {
      const r = validateSummary(v, { title: "Anything" });
      assert.equal(r.ok, false);
      assert.deepEqual(r.reasons, ["empty"]);
    }
  });

  test("no name anchor anywhere in the summary", () => {
    const r = validateSummary(
      "We talked about the weather and decided to grab coffee tomorrow.",
      { title: "HyET pricing", slug: "hyet-pricing" },
    );
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("no-name-anchor"));
  });

  test("too short even if it mentions the topic", () => {
    const r = validateSummary("HyET pricing.", { title: "HyET pricing" });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("too-short"));
  });

  test("vague text that mentions topic but has no concrete signal", () => {
    // Lowercase title + no numbers / dates / proper nouns / decisions
    // verbs → only the name anchor passes; everything else fails.
    const r = validateSummary(
      "we talked about the pricing thing for a while kind of inconclusive",
      { title: "pricing thing" },
    );
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(r.reasons.includes("no-concrete-detail"));
  });
});

describe("buildNameAnchors", () => {
  test("expands slugs into part anchors", () => {
    const anchors = buildNameAnchors({
      title: "HyET pricing",
      slug: "hyet-pricing",
    });
    assert.ok(anchors.includes("hyet pricing"));
    assert.ok(anchors.includes("hyet"));
    assert.ok(anchors.includes("pricing"));
  });

  test("drops tokens shorter than 3 chars", () => {
    const anchors = buildNameAnchors({ title: "AI dx", slug: "ai-dx" });
    assert.ok(anchors.includes("ai dx"));
    assert.ok(!anchors.includes("ai"));
    assert.ok(!anchors.includes("dx"));
  });

  test("accepts aliases array", () => {
    const anchors = buildNameAnchors({
      title: "Mic setup",
      aliases: ["mic", "Audio glitch"],
    });
    assert.ok(anchors.includes("mic setup"));
    assert.ok(anchors.includes("audio glitch"));
  });
});

describe("qualityFlag wrapper", () => {
  test("ok → pass; not ok → weak", () => {
    assert.equal(
      qualityFlag({ ok: true, reasons: [], signals: ["number"] }),
      "pass",
    );
    assert.equal(
      qualityFlag({ ok: false, reasons: ["empty"], signals: [] }),
      "weak",
    );
  });
});
