import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcalBuddyOutput } from "../lib/companion-calendar";

test("parses a single event with datetime + location", () => {
  const raw = [
    "* Standup",
    "    5 May 2026 at 10:00 - 10:15",
    "    location: Office",
  ].join("\n");
  const events = parseIcalBuddyOutput(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Standup");
  assert.match(events[0].when, /10:00/);
  assert.equal(events[0].location, "Office");
});

test("parses multiple events separated by blank lines", () => {
  const raw = [
    "* Standup",
    "    today at 10:00 - 10:15",
    "",
    "* Lunch with Ilias",
    "    today at 12:30 - 13:30",
    "    location: Cafe",
  ].join("\n");
  const events = parseIcalBuddyOutput(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, "Standup");
  assert.equal(events[1].title, "Lunch with Ilias");
  assert.equal(events[1].location, "Cafe");
});

test("event with no location leaves location null", () => {
  const raw = ["* Focus block", "    tomorrow at 14:00 - 16:00"].join("\n");
  const events = parseIcalBuddyOutput(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].location, null);
});

test("empty / whitespace input returns no events", () => {
  assert.deepEqual(parseIcalBuddyOutput(""), []);
  assert.deepEqual(parseIcalBuddyOutput("   \n  \n"), []);
});

test("handles CRLF line endings", () => {
  const raw = "* Sync\r\n    today at 09:00 - 09:30\r\n    location: Zoom\r\n";
  const events = parseIcalBuddyOutput(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Sync");
  assert.equal(events[0].location, "Zoom");
});

test("a title-only event (no props) is still captured", () => {
  const raw = "* All-day offsite";
  const events = parseIcalBuddyOutput(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "All-day offsite");
  assert.equal(events[0].when, "");
});
