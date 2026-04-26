import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, getProjectRoot } from "./config";

const DB_PATH = path.resolve(process.cwd(), "data", "amaso.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT    NOT NULL UNIQUE,
      password     TEXT    NOT NULL,
      name         TEXT    NOT NULL,
      role         TEXT    NOT NULL CHECK (role IN ('admin','team','client')),
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_access (
      user_id    INTEGER NOT NULL,
      project_id TEXT    NOT NULL,
      PRIMARY KEY (user_id, project_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Remarks: added nullable `path` (project-level) and required `category`
  // since v2. SQLite can't ALTER a NOT NULL constraint, so we detect the old
  // schema by missing column and drop-recreate. Safe because remarks data is
  // early-stage; if that changes we'll need a proper copy-migrate.
  const cols = d
    .prepare("PRAGMA table_info(remarks)")
    .all() as { name: string }[];
  const hasCategory = cols.some((c) => c.name === "category");
  if (cols.length > 0 && !hasCategory) {
    d.exec("DROP TABLE remarks");
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS remarks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      project_id TEXT    NOT NULL,
      path       TEXT,                 -- NULL = project-level remark
      line       INTEGER,              -- NULL unless path is set
      category   TEXT    NOT NULL CHECK (category IN ('frontend','backend','other')),
      body       TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    -- Context column added later; additive so we ALTER safely below.
    CREATE INDEX IF NOT EXISTS idx_remarks_file
      ON remarks (project_id, path);
    CREATE INDEX IF NOT EXISTS idx_remarks_project
      ON remarks (project_id, created_at);

    CREATE TABLE IF NOT EXISTS remark_attachments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      remark_id  INTEGER NOT NULL,
      filename   TEXT    NOT NULL,
      mime_type  TEXT    NOT NULL,
      size       INTEGER NOT NULL,
      storage_key TEXT   NOT NULL,    -- filename stored under data/remarks/{remark_id}/
      created_at INTEGER NOT NULL,
      FOREIGN KEY (remark_id) REFERENCES remarks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_remark
      ON remark_attachments (remark_id);
  `);

  // Additive `context` column for remarks captured via the preview inspector.
  // Stored as JSON; structure is defined client-side (tag, id, classes,
  // attrs, text snippet, outerHtml excerpt, locator, pageUrl). Nullable.
  const remarkCols = d
    .prepare("PRAGMA table_info(remarks)")
    .all() as { name: string }[];
  if (!remarkCols.some((c) => c.name === "context")) {
    d.exec("ALTER TABLE remarks ADD COLUMN context TEXT");
  }
  if (!remarkCols.some((c) => c.name === "column")) {
    // Column number from the inspector pick — only populated for preview picks.
    d.exec("ALTER TABLE remarks ADD COLUMN column INTEGER");
  }
  // Nullable timestamp: when this remark was picked up + resolved by a
  // Claude fix run (or manually by an admin).
  if (!remarkCols.some((c) => c.name === "resolved_at")) {
    d.exec("ALTER TABLE remarks ADD COLUMN resolved_at INTEGER");
  }
  // Added with the Spar CRUD expansion: tags for free-form
  // categorisation ("bug", "ui", "ideas-later") and updated_at so
  // edits can be surfaced without guessing. Both additive; existing
  // rows keep tags=NULL (≡ []) and updated_at=NULL (≡ created_at on
  // read).
  if (!remarkCols.some((c) => c.name === "tags")) {
    d.exec("ALTER TABLE remarks ADD COLUMN tags TEXT");
  }
  if (!remarkCols.some((c) => c.name === "updated_at")) {
    d.exec("ALTER TABLE remarks ADD COLUMN updated_at INTEGER");
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS chat_channels (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT    NOT NULL CHECK (kind IN ('general','project','dm')),
      project_id TEXT,                 -- set when kind='project'
      name       TEXT,                 -- set when kind='general' or 'project'
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_general
      ON chat_channels (kind) WHERE kind = 'general';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_project
      ON chat_channels (project_id) WHERE kind = 'project';

    CREATE TABLE IF NOT EXISTS chat_channel_members (
      channel_id INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      PRIMARY KEY (channel_id, user_id),
      FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)    REFERENCES users(id)         ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_members_user
      ON chat_channel_members (user_id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      kind       TEXT    NOT NULL DEFAULT 'text'
                          CHECK (kind IN ('text','ai_session','system')),
      body       TEXT    NOT NULL,
      meta       TEXT,                 -- JSON: extra info per kind (e.g. ai project_id)
      created_at INTEGER NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)    REFERENCES users(id)         ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_channel
      ON chat_messages (channel_id, created_at);

    CREATE TABLE IF NOT EXISTS chat_channel_reads (
      user_id      INTEGER NOT NULL,
      channel_id   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id),
      FOREIGN KEY (user_id)    REFERENCES users(id)         ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_message_attachments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      filename   TEXT    NOT NULL,
      mime_type  TEXT    NOT NULL,
      size       INTEGER NOT NULL,
      storage_key TEXT   NOT NULL,       -- filename stored under data/chat/{message_id}/
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_msg
      ON chat_message_attachments (message_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      endpoint   TEXT    NOT NULL UNIQUE,
      p256dh     TEXT    NOT NULL,
      auth       TEXT    NOT NULL,
      user_agent TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user
      ON push_subscriptions (user_id);

    -- Browser-action recordings captured by the Chrome extension.
    -- One row per start-stop cycle of the header record button. The
    -- extension POSTs events in batches during the session's lifetime;
    -- end_at is set when the user clicks the header icon again.
    CREATE TABLE IF NOT EXISTS recording_sessions (
      id         TEXT    PRIMARY KEY,            -- randomUUID
      user_id    INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER,
      status     TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','ended')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_recording_sessions_user
      ON recording_sessions (user_id, started_at);

    CREATE TABLE IF NOT EXISTS recording_events (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id           TEXT    NOT NULL,
      client_id            TEXT    NOT NULL,
      type                 TEXT    NOT NULL
                             CHECK (type IN ('click','input','submit','navigation','keydown')),
      timestamp            INTEGER NOT NULL,
      url                  TEXT    NOT NULL,
      title                TEXT,
      target_json          TEXT,                 -- serialized RecordingEventTarget
      value                TEXT,
      needs_clarification  INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
      clarification_reason TEXT,
      clarification        TEXT,                 -- user-written post-hoc explanation
      FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
      UNIQUE (session_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_recording_events_session
      ON recording_events (session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_recording_events_flagged
      ON recording_events (session_id, needs_clarification) WHERE needs_clarification = 1;
  `);

  // Additive columns for the end-of-session experience: the user-given
  // title, and a simple analysis queue marker. Added after the initial
  // schema shipped, so detect-and-ALTER instead of including them in the
  // CREATE above.
  const recCols = d
    .prepare("PRAGMA table_info(recording_sessions)")
    .all() as { name: string }[];
  if (!recCols.some((c) => c.name === "name")) {
    d.exec("ALTER TABLE recording_sessions ADD COLUMN name TEXT");
  }
  if (!recCols.some((c) => c.name === "analysis_status")) {
    // 'queued' | 'running' | 'completed' | 'failed' — NULL = never requested.
    d.exec("ALTER TABLE recording_sessions ADD COLUMN analysis_status TEXT");
  }
  if (!recCols.some((c) => c.name === "analysis_result")) {
    d.exec("ALTER TABLE recording_sessions ADD COLUMN analysis_result TEXT");
  }
  // Optional link to the automation that kicked off this recording. NULL
  // for ad-hoc sessions started without launching an automation. Indexed
  // because the automations list joins on it to compute per-row stats.
  if (!recCols.some((c) => c.name === "automation_id")) {
    d.exec("ALTER TABLE recording_sessions ADD COLUMN automation_id INTEGER");
    d.exec(
      "CREATE INDEX IF NOT EXISTS idx_recording_sessions_automation ON recording_sessions (automation_id)",
    );
  }

  // Seed the 'general' channel if missing.
  const hasGeneral = d
    .prepare("SELECT 1 FROM chat_channels WHERE kind = 'general'")
    .get();
  if (!hasGeneral) {
    d.prepare(
      "INSERT INTO chat_channels (kind, project_id, name, created_at) VALUES ('general', NULL, ?, ?)",
    ).run("General", Date.now());
  }

  d.exec(`
    -- Quick-action launcher entries shown on /automations. Each row is a
    -- named URL; future automation kinds (spar dispatch, shell, etc.)
    -- can land in payload_json without a schema migration.
    CREATE TABLE IF NOT EXISTS automations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT,
      kind        TEXT    NOT NULL DEFAULT 'url'
                          CHECK (kind IN ('url')),
      payload_json TEXT   NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automations_sort
      ON automations (sort_order, id);
  `);
  seedAutomations(d);

  d.exec(`
    -- Brain page graph data (Phase 2). Initially seeded from data/graph.json
    -- on first run; mutated thereafter via /api/graph/* routes. Edges cascade
    -- on node delete because a half-deleted edge has no useful meaning.
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL CHECK (type IN ('project','person','tech','blocker','decision')),
      label      TEXT NOT NULL,
      status     TEXT,
      notes      TEXT,
      claude_md  TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS graph_edges (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      label  TEXT,
      FOREIGN KEY (source) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target) REFERENCES graph_nodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges (source);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges (target);
  `);
  seedGraph(d);

  // First-run backfill for the unread-badge feature: assume every existing
  // user has already seen every existing channel so we don't surprise people
  // with a flood of "unread" counts the first time the app is upgraded.
  // Idempotent (ignored once rows exist).
  const reads = d
    .prepare("SELECT COUNT(*) AS n FROM chat_channel_reads")
    .get() as { n: number };
  if (reads.n === 0) {
    const now = Date.now();
    // For every user × visible channel (general + project + dm member), seed
    // a row. Project-visibility is enforced client-side on read — here we
    // simply blanket-mark all channels as seen so new rollouts don't spike.
    d.exec(`
      INSERT OR IGNORE INTO chat_channel_reads (user_id, channel_id, last_seen_at)
      SELECT u.id, c.id, ${now}
        FROM users u
        CROSS JOIN chat_channels c
       WHERE c.kind IN ('general','project')
          OR (c.kind = 'dm' AND c.id IN (
              SELECT channel_id FROM chat_channel_members WHERE user_id = u.id
          ));
    `);
  }

  // Per-project roadmap: ordered, hierarchical checklist of steps
  // (and sub-steps via parent_id) so the UI can render a flowchart-
  // style progress view. Two-level hierarchy in practice — schema
  // allows arbitrary depth but the UI clamps to step → sub-step.
  // ON DELETE CASCADE so deleting a step removes its children.
  d.exec(`
    CREATE TABLE IF NOT EXISTS roadmap_steps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT    NOT NULL,
      parent_id   INTEGER,
      position    INTEGER NOT NULL DEFAULT 0,
      title       TEXT    NOT NULL,
      done        INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES roadmap_steps(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_project
      ON roadmap_steps (project_id, parent_id, position);
  `);

  // Super-user activity tracking. Two tables, both append-mostly:
  //   user_presence  — one row per live browser tab. Heartbeated every
  //                    30 s; rows older than the offline-threshold are
  //                    treated as ended sessions but kept on disk for
  //                    historical session-count reporting.
  //   user_activity  — append-only event log (page_visit, action). The
  //                    tracker writes a page_visit on every navigation
  //                    and any caller can post a feature-usage event
  //                    via /api/admin/activity.
  d.exec(`
    CREATE TABLE IF NOT EXISTS user_presence (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      client_id     TEXT    NOT NULL,           -- random per-tab id from the tracker
      connected_at  INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      current_path  TEXT,
      user_agent    TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_presence_client
      ON user_presence (user_id, client_id);
    CREATE INDEX IF NOT EXISTS idx_user_presence_lastseen
      ON user_presence (last_seen_at);

    CREATE TABLE IF NOT EXISTS user_activity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      presence_id   INTEGER,                    -- NULL if presence row was pruned
      kind          TEXT    NOT NULL CHECK (kind IN ('page_visit','action')),
      label         TEXT    NOT NULL,
      detail        TEXT,                       -- JSON, optional
      at            INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_activity_recent
      ON user_activity (at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_activity_user
      ON user_activity (user_id, at DESC);

    -- Offline queue for commands the dashboard tried to dispatch to a
    -- companion that wasn't connected. Each row is one attempt to send
    -- a CompanionCommand; the WebSocket layer flushes them in
    -- enqueued_at order the moment a fresh companion socket comes up
    -- for the user. expires_at is the wall-clock TTL — stale rows are
    -- dropped on flush rather than replayed. Persisting in SQLite (vs
    -- in-memory) means a dashboard restart between dispatch and
    -- companion reconnect doesn't lose the command.
    CREATE TABLE IF NOT EXISTS companion_command_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      command_id      TEXT    NOT NULL,        -- the wire id we'll re-use on flush
      command_json    TEXT    NOT NULL,        -- serialised CompanionCommand
      enqueued_at     INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_companion_queue_user
      ON companion_command_queue (user_id, enqueued_at);
    CREATE INDEX IF NOT EXISTS idx_companion_queue_expiry
      ON companion_command_queue (expires_at);
  `);
}

/** Seed the launcher with Outlook on first run so the page isn't empty
 *  the first time the user opens it. Idempotent — only fires when the
 *  table is brand new. */
function seedAutomations(d: Database.Database) {
  const existing = d.prepare("SELECT COUNT(*) AS n FROM automations").get() as {
    n: number;
  };
  if (existing.n > 0) return;
  const now = Date.now();
  d.prepare(
    "INSERT INTO automations (name, description, kind, payload_json, enabled, sort_order, created_at, updated_at) VALUES (?, ?, 'url', ?, 1, 0, ?, ?)",
  ).run(
    "Outlook",
    "Inbox + calendar",
    JSON.stringify({ url: "https://outlook.office.com" }),
    now,
    now,
  );
}

/**
 * One-time seed of graph_nodes / graph_edges from data/graph.json. Skips
 * silently when the JSON file is missing or graph_nodes already has rows
 * (subsequent edits land in SQLite and JSON is no longer authoritative).
 * For project nodes we try to read the corresponding CLAUDE.md from the
 * configured project path; missing files leave claude_md NULL.
 */
function seedGraph(d: Database.Database) {
  const existing = d.prepare("SELECT COUNT(*) AS n FROM graph_nodes").get() as {
    n: number;
  };
  if (existing.n > 0) return;

  const jsonPath = path.join(process.cwd(), "data", "graph.json");
  if (!fs.existsSync(jsonPath)) return;

  type SeedNode = {
    id: string;
    type: "project" | "person" | "tech" | "blocker" | "decision";
    label: string;
    status?: string;
    notes?: string;
  };
  type SeedEdge = { source: string; target: string; label?: string };
  let parsed: { nodes: SeedNode[]; edges: SeedEdge[] };
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    return;
  }

  const projectsById = new Map(loadConfig().projects.map((p) => [p.id, p]));
  const insertNode = d.prepare(
    "INSERT INTO graph_nodes (id, type, label, status, notes, claude_md, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEdge = d.prepare(
    "INSERT INTO graph_edges (source, target, label) VALUES (?, ?, ?)",
  );

  d.transaction(() => {
    const now = Date.now();
    for (const n of parsed.nodes) {
      let claudeMd: string | null = null;
      if (n.type === "project") {
        const proj = projectsById.get(n.id);
        if (proj) {
          const claudePath = path.join(getProjectRoot(proj), "CLAUDE.md");
          try {
            claudeMd = fs.readFileSync(claudePath, "utf8");
          } catch {
            claudeMd = null;
          }
        }
      }
      insertNode.run(
        n.id,
        n.type,
        n.label,
        n.status ?? null,
        n.notes ?? null,
        claudeMd,
        now,
      );
    }
    for (const e of parsed.edges) {
      insertEdge.run(e.source, e.target, e.label ?? null);
    }
  })();
}

/**
 * Re-read every project node's CLAUDE.md from disk and persist the
 * latest contents. Used by POST /api/graph/refresh-claude-md so users
 * don't have to restart the server when they edit the source files.
 * Returns the number of project nodes actually updated.
 */
export function refreshClaudeMd(): number {
  const db = getDb();
  const projects = db
    .prepare("SELECT id FROM graph_nodes WHERE type = 'project'")
    .all() as { id: string }[];
  const projectsById = new Map(loadConfig().projects.map((p) => [p.id, p]));
  const update = db.prepare(
    "UPDATE graph_nodes SET claude_md = ?, updated_at = ? WHERE id = ?",
  );
  const now = Date.now();
  let updated = 0;
  db.transaction(() => {
    for (const row of projects) {
      const proj = projectsById.get(row.id);
      if (!proj) continue;
      const claudePath = path.join(getProjectRoot(proj), "CLAUDE.md");
      let content: string | null = null;
      try {
        content = fs.readFileSync(claudePath, "utf8");
      } catch {
        content = null;
      }
      update.run(content, now, row.id);
      updated++;
    }
  })();
  return updated;
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: "admin" | "team" | "client";
  created_at: number;
}

export function publicUser(row: {
  id: number;
  email: string;
  name: string;
  role: User["role"];
  created_at: number;
}): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    created_at: row.created_at,
  };
}
