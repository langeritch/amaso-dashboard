/**
 * Brain-file ACL tests.
 *
 * Run with:  npm test
 *
 * Verifies that resolveInBrain (and through it, the three brain-file
 * tools) enforces per-user isolation at the path level:
 *   - users/<name>/** readable/writable only by the matching user
 *   - shared files (projects.md etc.) accessible by any user
 *   - unknown paths denied by default
 *   - list_brain_files with a foreign users/ subdir is denied
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Pull in the ACL resolver and the three tools under test.
import {
  resolveInBrain,
  readBrainFileTool,
  writeBrainFileTool,
  listBrainFilesTool,
  type SparContext,
} from "../lib/spar-tools-context.js";
import { BRAIN_ROOT } from "../lib/spar-brain.js";
import type { User } from "../lib/db.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const santiUser: User = {
  id: 1,
  email: "santi@amaso.nl",
  name: "Santi",
  role: "admin",
  created_at: 0,
};

const iliasUser: User = {
  id: 2,
  email: "ilias421@hotmail.com",
  name: "Ilias",
  role: "team",
  created_at: 0,
};

const santiCtx: SparContext = { user: santiUser, token: "test" };
const iliasCtx: SparContext = { user: iliasUser, token: "test" };

// Ensure users/ilias/ directory and profile file exist so the "can access
// own files" tests have something to read.
function ensureIliasProfile(): void {
  const dir = path.join(BRAIN_ROOT, "users", "ilias");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "profile.md");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `---\nname: Ilias — Profile\ndescription: Auto-created by brain-acl tests.\ntype: user\n---\n# Ilias\n\nProfile placeholder created by the brain-acl test suite.\n`,
      "utf8",
    );
  }
}

ensureIliasProfile();

// ---------------------------------------------------------------------------
// resolveInBrain — unit tests (no filesystem I/O, pure path logic)
// ---------------------------------------------------------------------------

describe("resolveInBrain — per-user isolation", () => {
  test("Ilias cannot resolve users/santi/profile.md", () => {
    assert.throws(
      () => resolveInBrain(iliasUser, "users/santi/profile.md"),
      (err: Error) => {
        assert.match(err.message, /access denied/i);
        return true;
      },
    );
  });

  test("Santi can resolve their own profile", () => {
    const abs = resolveInBrain(santiUser, "users/santi/profile.md");
    assert.ok(abs.includes("santi"));
  });

  test("Ilias can resolve their own profile", () => {
    const abs = resolveInBrain(iliasUser, "users/ilias/profile.md");
    assert.ok(abs.includes("ilias"));
  });

  test("Ilias cannot resolve any path under users/santi/", () => {
    const paths = [
      "users/santi/soul.md",
      "users/santi/preferences.md",
      "users/santi/calendar.md",
      "users/santi/daily/2026-05-11.md",
    ];
    for (const p of paths) {
      assert.throws(
        () => resolveInBrain(iliasUser, p),
        (err: Error) => {
          assert.match(err.message, /access denied/i);
          return true;
        },
        `expected denial for ${p}`,
      );
    }
  });
});

describe("resolveInBrain — shared allowlist", () => {
  test("shared files resolve for both users", () => {
    const shared = [
      "brain.md",
      "projects.md",
      "decisions.md",
      "lessons.md",
      "goals.md",
      "timeline.md",
      "people.md",
      "MEMORY.md",
      "daily/2026-05-11.md",
      "references/jiang_worldview.md",
      "plans/dashboard-productization.md",
    ];
    for (const p of shared) {
      assert.doesNotThrow(() => resolveInBrain(santiUser, p), `santi: ${p}`);
      assert.doesNotThrow(() => resolveInBrain(iliasUser, p), `ilias: ${p}`);
    }
  });

  test("unknown path is denied for any user", () => {
    const unknown = [
      "secrets.md",
      "backup/dump.md",
      "tmp/scratch.md",
    ];
    for (const p of unknown) {
      assert.throws(
        () => resolveInBrain(santiUser, p),
        (err: Error) => {
          assert.match(err.message, /access denied/i);
          return true;
        },
        `expected denial for ${p}`,
      );
      assert.throws(
        () => resolveInBrain(iliasUser, p),
        (err: Error) => {
          assert.match(err.message, /access denied/i);
          return true;
        },
        `expected denial for ${p}`,
      );
    }
  });

  test("path traversal is denied", () => {
    assert.throws(
      () => resolveInBrain(santiUser, "../etc/passwd"),
      /escapes|access denied|must be relative/i,
    );
  });

  test("absolute path is denied", () => {
    assert.throws(
      () => resolveInBrain(santiUser, "/etc/passwd"),
      /must be relative/i,
    );
  });
});

// ---------------------------------------------------------------------------
// readBrainFileTool — integration (hits real disk)
// ---------------------------------------------------------------------------

describe("readBrainFileTool — access control", () => {
  test("Ilias cannot read users/santi/profile.md", async () => {
    await assert.rejects(
      () => readBrainFileTool(iliasCtx, { rel_path: "users/santi/profile.md" }),
      /access denied/i,
    );
  });

  test("Ilias can read their own profile", async () => {
    const result = await readBrainFileTool(iliasCtx, {
      rel_path: "users/ilias/profile.md",
    });
    assert.equal(result.relPath, "users/ilias/profile.md");
    assert.ok(typeof result.content === "string");
  });

  test("Ilias can read projects.md", async () => {
    const result = await readBrainFileTool(iliasCtx, { rel_path: "projects.md" });
    assert.ok(typeof result.content === "string");
  });

  test("Santi can read projects.md", async () => {
    const result = await readBrainFileTool(santiCtx, { rel_path: "projects.md" });
    assert.ok(typeof result.content === "string");
  });
});

// ---------------------------------------------------------------------------
// writeBrainFileTool — access control
// ---------------------------------------------------------------------------

const TEST_TAG = `<!-- brain-acl-test-${Date.now()} -->`;

describe("writeBrainFileTool — access control", () => {
  test("Ilias cannot write to users/santi/profile.md", async () => {
    await assert.rejects(
      () =>
        writeBrainFileTool(iliasCtx, {
          rel_path: "users/santi/profile.md",
          content: "pwned",
        }),
      /access denied/i,
    );
  });

  test("Ilias can write to their own profile (whole-file mode)", async () => {
    const profilePath = path.join(BRAIN_ROOT, "users", "ilias", "profile.md");
    const original = fs.readFileSync(profilePath, "utf8");
    const tagged = original.trimEnd() + `\n${TEST_TAG}\n`;
    await assert.doesNotReject(
      writeBrainFileTool(iliasCtx, {
        rel_path: "users/ilias/profile.md",
        content: tagged,
      }),
    );
    const after = fs.readFileSync(profilePath, "utf8");
    assert.ok(after.includes(TEST_TAG));
    // Restore so tests are idempotent.
    fs.writeFileSync(profilePath, original, "utf8");
  });

  test("Both users can write to decisions.md (whole-file round-trip)", async () => {
    const decisionsPath = path.join(BRAIN_ROOT, "decisions.md");
    if (!fs.existsSync(decisionsPath)) {
      fs.writeFileSync(decisionsPath, "# Decisions\n\n(placeholder)\n", "utf8");
    }
    const original = fs.readFileSync(decisionsPath, "utf8");
    const tagged = original.trimEnd() + `\n${TEST_TAG}\n`;
    // Santi writes.
    await assert.doesNotReject(
      writeBrainFileTool(santiCtx, {
        rel_path: "decisions.md",
        content: tagged,
      }),
    );
    // Ilias writes back to original.
    await assert.doesNotReject(
      writeBrainFileTool(iliasCtx, {
        rel_path: "decisions.md",
        content: original,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// listBrainFilesTool — subdir ACL
// ---------------------------------------------------------------------------

describe("listBrainFilesTool — subdir access control", () => {
  test("list_brain_files subdir=users/santi from Ilias is denied", async () => {
    await assert.rejects(
      () => listBrainFilesTool(iliasCtx, { subdir: "users/santi" }),
      /access denied/i,
    );
  });

  test("list_brain_files subdir=users/santi from Santi is allowed", async () => {
    const result = await listBrainFilesTool(santiCtx, { subdir: "users/santi" });
    assert.ok(Array.isArray(result.entries));
  });

  test("list_brain_files subdir=users/ilias from Ilias is allowed", async () => {
    const result = await listBrainFilesTool(iliasCtx, { subdir: "users/ilias" });
    assert.ok(Array.isArray(result.entries));
  });

  test("list_brain_files subdir=daily from any user is allowed", async () => {
    await assert.doesNotReject(
      listBrainFilesTool(santiCtx, { subdir: "daily" }),
    );
    await assert.doesNotReject(
      listBrainFilesTool(iliasCtx, { subdir: "daily" }),
    );
  });

  test("list_brain_files subdir=secrets (unknown) is denied", async () => {
    await assert.rejects(
      () => listBrainFilesTool(iliasCtx, { subdir: "secrets" }),
      /access denied/i,
    );
  });
});
