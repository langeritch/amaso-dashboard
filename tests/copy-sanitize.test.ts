import { test } from "node:test";
import assert from "node:assert/strict";
import { stripEmDashes } from "../lib/copy-sanitize";

test("replaces an em-dash with space-hyphen-space", () => {
  assert.equal(stripEmDashes("foo—bar"), "foo - bar");
});

test("replaces an en-dash with space-hyphen-space", () => {
  assert.equal(stripEmDashes("3–5"), "3 - 5");
});

test("collapses existing spaces around the dash (no double spaces)", () => {
  assert.equal(stripEmDashes("foo — bar"), "foo - bar");
});

test("leaves regular hyphens and ordinary text untouched", () => {
  assert.equal(stripEmDashes("a-b is normal text"), "a-b is normal text");
});

test("handles multiple dashes and is idempotent", () => {
  const once = stripEmDashes("a—b–c");
  assert.equal(once, "a - b - c");
  assert.equal(stripEmDashes(once), once);
});

test("does not collapse across newlines", () => {
  assert.equal(stripEmDashes("line1—\nline2"), "line1 - \nline2");
});

test("empty / falsy input is returned as-is", () => {
  assert.equal(stripEmDashes(""), "");
});
