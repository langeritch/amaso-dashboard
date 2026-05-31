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
  // Cap WAL growth at 100 MB so a long-running write storm (heartbeat
  // ticks, daily extraction, chat bursts) can't fill the disk with
  // uncommitted journal pages. SQLite auto-truncates back to this on
  // the next checkpoint.
  db.pragma("journal_size_limit = 100000000");
  // 5s busy timeout. With WAL, readers don't block writers, but a long
  // write or vacuum can still make a concurrent writer wait — better
  // to wait briefly than to throw SQLITE_BUSY at the API caller.
  db.pragma("busy_timeout = 5000");
  // NORMAL is the right durability/perf tradeoff under WAL: writes
  // survive process crash, but not a hard power loss between commit
  // and the next fsync. For a single-box dashboard with a watchdog
  // restart, that's the right point on the curve.
  db.pragma("synchronous = NORMAL");
  // Tombstone deleted rows on disk. Costs a small write amplification;
  // gains: a leaked DB backup doesn't carry old session tokens, deleted
  // user records, etc. in free-space pages.
  db.pragma("secure_delete = ON");
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

    CREATE TABLE IF NOT EXISTS magic_links (
      id         TEXT    PRIMARY KEY,              -- signed token
      user_id    INTEGER NOT NULL,
      email      TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER,                         -- NULL until consumed
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_magic_links_email_active
      ON magic_links (email) WHERE used_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_magic_links_user
      ON magic_links (user_id);

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

    -- Append-only audit trail for security-relevant admin actions.
    -- Never updated, never deleted from app code. Schema is deliberately
    -- denormalized (actor_email, target_email captured at write time)
    -- so retiring or renaming a user doesn't rewrite their history.
    CREATE TABLE IF NOT EXISTS audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      actor_id      INTEGER,
      actor_email   TEXT,
      actor_ip      TEXT,
      action        TEXT    NOT NULL,
      target_kind   TEXT,
      target_id     TEXT,
      target_email  TEXT,
      meta_json     TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts);
    CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action);
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
  // Item 6 - remarks become lightweight tasks. All additive + nullable so
  // existing rows keep working: on read, status defaults to 'open' and
  // priority to 'med' (NULL ≡ default), assignee/due stay empty. No CHECK
  // constraints (SQLite can't add them via ALTER) — the API validates the
  // allowed values instead.
  if (!remarkCols.some((c) => c.name === "status")) {
    // open | in-progress | blocked | done
    d.exec("ALTER TABLE remarks ADD COLUMN status TEXT");
  }
  if (!remarkCols.some((c) => c.name === "priority")) {
    // low | med | high
    d.exec("ALTER TABLE remarks ADD COLUMN priority TEXT");
  }
  if (!remarkCols.some((c) => c.name === "assignee_id")) {
    d.exec("ALTER TABLE remarks ADD COLUMN assignee_id INTEGER");
  }
  if (!remarkCols.some((c) => c.name === "due_at")) {
    d.exec("ALTER TABLE remarks ADD COLUMN due_at INTEGER");
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
    -- Editor documents with Git commit history.
    CREATE TABLE IF NOT EXISTS editor_documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,                 -- filename or title
      path       TEXT    NOT NULL UNIQUE,          -- relative path in Git repo
      language   TEXT    NOT NULL DEFAULT 'plain', -- programming language hint
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_editor_documents_updated
      ON editor_documents (updated_at);

    CREATE TABLE IF NOT EXISTS editor_commits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id   INTEGER NOT NULL,
      commit_hash   TEXT    NOT NULL UNIQUE,      -- git object hash
      author_id     INTEGER NOT NULL,
      message       TEXT    NOT NULL,
      content       TEXT    NOT NULL,             -- full document content at this commit
      diff_from_parent TEXT,                      -- optional unified diff
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES editor_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_editor_commits_document
      ON editor_commits (document_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_editor_commits_author
      ON editor_commits (author_id);
  `);

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

  // Origin tag added when bridging the per-user spar graph (data/graph/{uid}.json,
  // see lib/spar-graph.ts) into SQLite. NULL = created/edited via the brain UI;
  // "spar:<uid>" = synced from that user's spar graph. Sync uses this to scope
  // its own deletes so brain-UI-authored rows are never touched.
  const nodeCols = d.prepare("PRAGMA table_info(graph_nodes)").all() as {
    name: string;
  }[];
  if (!nodeCols.some((c) => c.name === "origin")) {
    d.exec("ALTER TABLE graph_nodes ADD COLUMN origin TEXT");
    d.exec("CREATE INDEX IF NOT EXISTS idx_graph_nodes_origin ON graph_nodes (origin)");
  }
  const edgeCols = d.prepare("PRAGMA table_info(graph_edges)").all() as {
    name: string;
  }[];
  if (!edgeCols.some((c) => c.name === "origin")) {
    d.exec("ALTER TABLE graph_edges ADD COLUMN origin TEXT");
    d.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_origin ON graph_edges (origin)");
  }

  // Widen the type CHECK constraint to accept 'milestone'. SQLite doesn't
  // support modifying CHECK in place, so we recreate the table when the
  // existing definition is missing the new value. Standard 12-step pattern
  // from sqlite.org/lang_altertable.html — done inside one transaction
  // with FK enforcement disabled so graph_edges' references survive the
  // swap.
  const nodeSchema = d
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='graph_nodes'")
    .get() as { sql: string } | undefined;
  if (nodeSchema && !nodeSchema.sql.includes("'milestone'")) {
    d.pragma("foreign_keys = OFF");
    d.transaction(() => {
      d.exec(`
        CREATE TABLE graph_nodes_new (
          id         TEXT PRIMARY KEY,
          type       TEXT NOT NULL CHECK (type IN ('project','person','tech','blocker','decision','milestone')),
          label      TEXT NOT NULL,
          status     TEXT,
          notes      TEXT,
          claude_md  TEXT,
          updated_at INTEGER NOT NULL,
          origin     TEXT
        );
        INSERT INTO graph_nodes_new (id, type, label, status, notes, claude_md, updated_at, origin)
          SELECT id, type, label, status, notes, claude_md, updated_at, origin FROM graph_nodes;
        DROP TABLE graph_nodes;
        ALTER TABLE graph_nodes_new RENAME TO graph_nodes;
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_origin ON graph_nodes (origin);
      `);
    })();
    d.pragma("foreign_key_check");
    d.pragma("foreign_keys = ON");
  }

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

    -- Autopilot per-user state. The toggle is now a mode switch on the
    -- auto-report path (not a cron dispatcher); this row anchors both
    -- the on/off bit (the "enabled" column) and the optional
    -- "directive" string -- the strategic mission/north star the
    -- autonomous loop reads when picking and creating tasks. Saving a
    -- directive while autopilot is off is allowed (the directive is
    -- preserved); only "enabled" gates the runtime behaviour. Keyed
    -- by user_id so toggling is idempotent; CASCADE on user delete so
    -- the row goes when the account does.
    CREATE TABLE IF NOT EXISTS autopilot_users (
      user_id    INTEGER PRIMARY KEY,
      enabled_at INTEGER NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      directive  TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Persisted spar conversations: each user keeps a server-side
    -- transcript per thread so reloads, device switches, and the new
    -- left-sidebar thread list all read from the same source. Messages
    -- arrive via /api/spar/conversations/[id]/messages — the streaming
    -- /api/spar route persists at the end of each turn. tool_calls is
    -- a JSON snapshot of any tool steps the assistant emitted that
    -- turn so the rendered transcript can show the same step cards on
    -- a different device. Title is auto-derived from the first user
    -- message (or "New conversation" until one arrives) so the
    -- sidebar list reads naturally without a separate rename UI.
    CREATE TABLE IF NOT EXISTS spar_conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      title      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_spar_conversations_user
      ON spar_conversations (user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS spar_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role            TEXT    NOT NULL CHECK (role IN ('user','assistant','system')),
      content         TEXT    NOT NULL,
      tool_calls      TEXT,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES spar_conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_spar_messages_conv
      ON spar_messages (conversation_id, created_at);
  `);

  // Additive columns layered on top of spar_conversations as the
  // auto-naming + drift detection landed: drift_notice surfaces a
  // soft "consider starting a new chat" banner when Haiku decides the
  // thread has wandered; auto_named flips true on the first
  // server-generated title so user-renamed threads stay sticky;
  // last_named_at_count records how many assistant turns were behind
  // the last (re-)naming so the same trigger doesn't fire twice when
  // a tab races. All optional — pre-existing rows simply read NULL.
  const sparConvCols = d
    .prepare("PRAGMA table_info(spar_conversations)")
    .all() as { name: string }[];
  if (!sparConvCols.some((c) => c.name === "drift_notice")) {
    d.exec("ALTER TABLE spar_conversations ADD COLUMN drift_notice TEXT");
  }
  if (!sparConvCols.some((c) => c.name === "auto_named")) {
    d.exec(
      "ALTER TABLE spar_conversations ADD COLUMN auto_named INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!sparConvCols.some((c) => c.name === "last_named_at_count")) {
    d.exec(
      "ALTER TABLE spar_conversations ADD COLUMN last_named_at_count INTEGER NOT NULL DEFAULT 0",
    );
  }
  // Per-task conversation linkage. When non-null, the conversation
  // belongs to a task and is rendered in the Tasks tab's chat view
  // instead of the main spar chat sidebar. Index supports the
  // `getConversationByTaskId` lookup the task agent uses on every
  // message persist.
  if (!sparConvCols.some((c) => c.name === "task_id")) {
    d.exec("ALTER TABLE spar_conversations ADD COLUMN task_id TEXT");
    d.exec(
      "CREATE INDEX IF NOT EXISTS idx_spar_conversations_task ON spar_conversations (task_id)",
    );
  }

  // Additive: directive + enabled columns on autopilot_users. The old
  // schema treated row-presence as the on bit; the directive feature
  // wants to persist a directive while autopilot is off, so we split
  // those into an explicit `enabled` column. Existing rows are
  // back-filled enabled=1 (they were on before the migration). New
  // installs get the column from the CREATE TABLE above.
  const autopilotCols = d
    .prepare("PRAGMA table_info(autopilot_users)")
    .all() as { name: string }[];
  if (!autopilotCols.some((c) => c.name === "directive")) {
    d.exec("ALTER TABLE autopilot_users ADD COLUMN directive TEXT");
  }
  if (!autopilotCols.some((c) => c.name === "enabled")) {
    d.exec(
      "ALTER TABLE autopilot_users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
    );
  }

  d.exec(`

    -- Heartbeat tick history. One row per cron tick per user, regardless
    -- of whether tier 1 fired. Powers the /heartbeat monitoring page
    -- timeline. tier1_results is JSON describing which deterministic
    -- checks fired (open remarks, time keyword, stale, idle terminals);
    -- tier2_summary is the model's verdict text when tier 2 ran (NULL
    -- when tier 1 was clean and we short-circuited). notified is true if
    -- the user got a push notification this tick.
    CREATE TABLE IF NOT EXISTS heartbeat_ticks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      at             INTEGER NOT NULL,
      status         TEXT    NOT NULL CHECK (status IN ('ok','alert')),
      tier1_results  TEXT,
      tier2_summary  TEXT,
      notified       INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeat_ticks_user_at
      ON heartbeat_ticks (user_id, at DESC);

    CREATE TABLE IF NOT EXISTS app_migrations (
      name       TEXT    PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  // Daily chat summaries: one per user per day, generated on first app
  // open of a new day. topics is a JSON array of { name, description,
  // projectId?, messageIds[] }. UNIQUE on (date, user_id) so concurrent
  // triggers are safe.
  d.exec(`
    CREATE TABLE IF NOT EXISTS daily_summaries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT    NOT NULL,
      user_id         INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      summary         TEXT    NOT NULL,
      topics          TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (date, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_summaries_user
      ON daily_summaries (user_id, date DESC);
  `);

  // Smart Topic System — Layer 0. Persistent, slug-addressable topics
  // scoped per user, so every account gets its own brain. `topics` is
  // the lightweight index row; `spar_message_topics` links a
  // spar_messages row to one or more of that user's topics with a
  // relevance score so post-day extraction can rank membership without
  // rewriting history. Slugs are unique per user, not global, so two
  // people can both have a "amaso-dashboard" topic. message_count and
  // last_active_at are denormalized counters maintained by lib/topics.ts
  // on attach so the sidebar can list topics without aggregate joins.
  d.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      slug           TEXT    NOT NULL,
      title          TEXT    NOT NULL,
      summary        TEXT,
      status         TEXT    NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','archived')),
      message_count  INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      UNIQUE (user_id, slug),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_topics_user_last_active
      ON topics (user_id, last_active_at DESC);
    CREATE INDEX IF NOT EXISTS idx_topics_user_status_last_active
      ON topics (user_id, status, last_active_at DESC);

    CREATE TABLE IF NOT EXISTS spar_message_topics (
      topic_id   INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      relevance  REAL    NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (topic_id, message_id),
      FOREIGN KEY (topic_id)   REFERENCES topics(id)        ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES spar_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_spar_message_topics_message
      ON spar_message_topics (message_id, topic_id);

    -- Layer 1 detection: alternate strings the matcher will recognize as
    -- the same topic ("meridian-app" / "meridian" / "the meridian
    -- dashboard"). Aliases are scoped per topic; uniqueness is per
    -- (topic_id, alias) so the same alias can theoretically point at
    -- different users' topics — the detector always queries with
    -- user_id joined in.
    CREATE TABLE IF NOT EXISTS topic_aliases (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id   INTEGER NOT NULL,
      alias      TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (topic_id, alias),
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_topic_aliases_alias
      ON topic_aliases (alias);

    -- Layer 7: cross-references from a topic to brain files. file_path
    -- is relative to BRAIN_ROOT (e.g. "projects.md",
    -- "users/santi/profile.md"); section is the header slug within
    -- that file (e.g. "woonklasse", "budget-tier-landing-pages") and
    -- may be NULL when the ref points at the whole file. Uniqueness
    -- is per (topic, file, section) — COALESCE(section,'') keeps the
    -- whole-file ref from colliding with a section ref of the same
    -- file. updated_at tracks the most recent extraction touch so the
    -- 4000-char cap in the reader prefers freshly-refreshed sections.
    CREATE TABLE IF NOT EXISTS topic_brain_refs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id   INTEGER NOT NULL,
      file_path  TEXT    NOT NULL,
      section    TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_brain_refs_unique
      ON topic_brain_refs (topic_id, file_path, COALESCE(section, ''));
    CREATE INDEX IF NOT EXISTS idx_topic_brain_refs_topic
      ON topic_brain_refs (topic_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_topic_brain_refs_file
      ON topic_brain_refs (file_path);
  `);

  // Layer 0 originally shipped without user_id. If the older shape is
  // present, drop and recreate — the table was empty in production
  // (Layer 0 has no writers yet), so we don't need a copy-migrate.
  // Detection is one query per boot; the recreate runs at most once.
  const topicsCols = d.prepare("PRAGMA table_info(topics)").all() as {
    name: string;
  }[];
  if (topicsCols.length > 0 && !topicsCols.some((c) => c.name === "user_id")) {
    d.exec("DROP TABLE IF EXISTS spar_message_topics");
    d.exec("DROP TABLE topics");
    d.exec(`
      CREATE TABLE topics (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL,
        slug           TEXT    NOT NULL,
        title          TEXT    NOT NULL,
        summary        TEXT,
        status         TEXT    NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','archived')),
        message_count  INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        UNIQUE (user_id, slug),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_topics_user_last_active
        ON topics (user_id, last_active_at DESC);
      CREATE INDEX idx_topics_user_status_last_active
        ON topics (user_id, status, last_active_at DESC);
      CREATE TABLE spar_message_topics (
        topic_id   INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        relevance  REAL    NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (topic_id, message_id),
        FOREIGN KEY (topic_id)   REFERENCES topics(id)        ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES spar_messages(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_spar_message_topics_message
        ON spar_message_topics (message_id, topic_id);
    `);
  }

  // Smart Topic System — Layer 3: per-user single rolling daily chat.
  // `daily_chats` maps a (user, local-date) pair to the conversation
  // row that owns that day's transcript. UNIQUE partial index pins
  // exactly one *active* row per day; older same-day rows hang around
  // with active=0 so legacy sessions stay visible in the sidebar but
  // new turns always route to active=1. Date strings are computed in
  // Europe/Amsterdam (see lib/local-date.ts) so a midnight roll lines
  // up with Santi's local clock, not server UTC.
  d.exec(`
    CREATE TABLE IF NOT EXISTS daily_chats (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      date_local      TEXT    NOT NULL,
      conversation_id INTEGER NOT NULL,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (user_id)         REFERENCES users(id)              ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES spar_conversations(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_chats_active_unique
      ON daily_chats (user_id, date_local) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS idx_daily_chats_user_date
      ON daily_chats (user_id, date_local DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_chats_conversation
      ON daily_chats (conversation_id);
  `);
  backfillDailyChats(d);
  backfillAssistantTopicLinks(d);

  // Post-day extraction tables.
  // daily_subjects: one row per (user, date) produced by extractDaySubjects.
  // Stores a JSON array of SubjectEntry objects consolidated from the day's
  // messages and topics. UNIQUE on (user_id, date) so concurrent triggers
  // are safe (INSERT OR REPLACE handles re-extraction).
  d.exec(`
    CREATE TABLE IF NOT EXISTS daily_subjects (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      date         TEXT    NOT NULL,
      subjects     TEXT    NOT NULL,
      generated_at INTEGER NOT NULL,
      UNIQUE (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_subjects_user_date
      ON daily_subjects (user_id, date);

    CREATE TABLE IF NOT EXISTS topic_transitions (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id         INTEGER NOT NULL REFERENCES spar_conversations(id),
      from_topic_id           INTEGER REFERENCES topics(id),
      to_topic_id             INTEGER NOT NULL REFERENCES topics(id),
      transition_type         TEXT    NOT NULL CHECK (transition_type IN ('new','return','merge')),
      triggered_by_message_id INTEGER REFERENCES spar_messages(id),
      timestamp               INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topic_transitions_conv
      ON topic_transitions (conversation_id, timestamp);

    -- Layer 4 (post-day extraction): audit row per (user, date) that
    -- captures the outcome of the nightly Haiku-driven extraction
    -- pass. status flips through pending → success | failed | skipped
    -- as the pipeline runs. fact_count + classifications_json power
    -- the admin dashboard; source_message_ids lets us trace a
    -- specific brain-file write back to the spar messages that
    -- produced it.
    CREATE TABLE IF NOT EXISTS daily_extractions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date                  TEXT    NOT NULL,
      run_at                INTEGER NOT NULL,
      status                TEXT    NOT NULL CHECK (status IN ('pending','success','failed','skipped')),
      fact_count            INTEGER NOT NULL DEFAULT 0,
      classifications_json  TEXT    NOT NULL DEFAULT '{}',
      source_message_ids    TEXT    NOT NULL DEFAULT '[]',
      error_text            TEXT,
      UNIQUE (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_extractions_user_date
      ON daily_extractions (user_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_extractions_status
      ON daily_extractions (status, run_at DESC);

    -- Layer 5: per-fact detail rows produced by each extraction run.
    -- The parent daily_extractions row keeps the aggregate (status,
    -- counts, source ids); this child table holds each accepted fact
    -- as its own row so the history-UI sidebar can list them and the
    -- L6 recall(type='keyword') tool can LIKE-search across them.
    --
    -- ON DELETE CASCADE so re-extraction (which deletes the parent
    -- and re-inserts) drops the stale child rows before the new ones
    -- land — same idempotency posture as the brain-file fingerprint
    -- guard in lib/daily-extraction.ts.
    CREATE TABLE IF NOT EXISTS extracted_facts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      extraction_id        INTEGER NOT NULL REFERENCES daily_extractions(id) ON DELETE CASCADE,
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date                 TEXT    NOT NULL,
      fact                 TEXT    NOT NULL,
      classification       TEXT    NOT NULL,
      brain_file           TEXT    NOT NULL,
      section              TEXT    NOT NULL,
      source_message_ids   TEXT    NOT NULL DEFAULT '[]',
      created_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_extracted_facts_user_date
      ON extracted_facts (user_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_extracted_facts_extraction
      ON extracted_facts (extraction_id);
    CREATE INDEX IF NOT EXISTS idx_extracted_facts_classification
      ON extracted_facts (user_id, classification);

    -- Layer 6: audit row per recall() tool invocation. Lets us tune
    -- the trigger phrases later by inspecting which lookups the model
    -- chose to fire and what they found. result_count is the number
    -- of message+fact bundles returned, not the row count of the
    -- underlying tables. Lightweight; no FK so a deleted user's
    -- invocation rows stay around for analysis.
    CREATE TABLE IF NOT EXISTS recall_invocations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      ts              INTEGER NOT NULL,
      type            TEXT    NOT NULL CHECK (type IN ('date','topic','keyword')),
      value           TEXT    NOT NULL,
      result_count    INTEGER NOT NULL DEFAULT 0,
      total_messages  INTEGER NOT NULL DEFAULT 0,
      total_facts     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_recall_invocations_user_ts
      ON recall_invocations (user_id, ts DESC);

    -- Smart Topic System — final pass (2026-05-14): per-(user, date,
    -- topic) rollup. Pure aggregate over spar_message_topics +
    -- spar_messages + daily_chats. Recomputed by the nightly
    -- extraction cron and lazily on history-UI reads; PK is the
    -- natural key so an UPSERT pattern keeps it idempotent.
    --
    -- This is what the spar prompt's "Active topics today" block and
    -- the list_topics tool read. Without this rollup every prompt
    -- would have to re-join three tables; with it, the prompt cost
    -- stays under a single indexed lookup.
    CREATE TABLE IF NOT EXISTS daily_topic_stats (
      user_id          INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      date             TEXT    NOT NULL,
      topic_id         INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      message_count    INTEGER NOT NULL DEFAULT 0,
      first_message_id INTEGER,
      last_message_id  INTEGER,
      first_ts         INTEGER,
      last_ts          INTEGER,
      computed_at      INTEGER NOT NULL,
      PRIMARY KEY (user_id, date, topic_id)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_topic_stats_user_date
      ON daily_topic_stats (user_id, date DESC, message_count DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_topic_stats_topic
      ON daily_topic_stats (topic_id, date DESC);

    -- Layer 6.5 (tense-aware recall hints): audit row per turn where
    -- a perfect-tense match fired and a hint was injected into the
    -- system prompt. model_called_recall is back-filled by the route
    -- when the assistant turn that received the hint actually
    -- invoked the recall tool — lets us measure whether the hint is
    -- pulling its weight before we add more matchers.
    CREATE TABLE IF NOT EXISTS tense_hint_invocations (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL,
      ts                  INTEGER NOT NULL,
      matched_phrase      TEXT    NOT NULL,
      suggested_keyword   TEXT,
      conversation_id     INTEGER,
      model_called_recall INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tense_hint_user_ts
      ON tense_hint_invocations (user_id, ts DESC);

    -- Remark #431: per-topic summary quality flag. NULL while
    -- the summary is fresh / unvalidated, 'pass' once the validator
    -- has signed off, 'weak' when even the regenerate-once retry
    -- failed. Readers that build context for recall / search filter
    -- out 'weak' rows by default so noisy summaries don't poison
    -- downstream prompts.
    --
    -- Subject-level quality (each subject inside daily_subjects.subjects
    -- JSON) is stored inline on the SubjectEntry object as
    -- 'quality_flag' so the per-entry granularity doesn't require a
    -- whole side table.
    CREATE TABLE IF NOT EXISTS summary_validation_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                INTEGER NOT NULL,
      source            TEXT    NOT NULL CHECK (source IN ('topic','subject','backfill')),
      ref_id            INTEGER,
      user_id           INTEGER,
      total             INTEGER NOT NULL DEFAULT 0,
      passed_first      INTEGER NOT NULL DEFAULT 0,
      regenerated       INTEGER NOT NULL DEFAULT 0,
      passed_after_regen INTEGER NOT NULL DEFAULT 0,
      remained_weak     INTEGER NOT NULL DEFAULT 0,
      notes             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_summary_validation_log_ts
      ON summary_validation_log (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_summary_validation_log_source
      ON summary_validation_log (source, ts DESC);
  `);

  // ALTER TABLE for the new topics.quality_flag column. SQLite ALTER
  // is idempotent-via-probe; the migrate() function runs at startup
  // on a connection that's already open, so PRAGMA table_info gives
  // us the existing columns and we add the new one when missing.
  const topicCols = d.prepare("PRAGMA table_info(topics)").all() as
    | Array<{ name: string }>
    | undefined;
  if (Array.isArray(topicCols) && !topicCols.some((c) => c.name === "quality_flag")) {
    d.exec("ALTER TABLE topics ADD COLUMN quality_flag TEXT");
  }

  // Companion activity: one row per heartbeat poll from a companion
  // device. Records the frontmost app, idle time, screen state, and
  // battery level so the dashboard can surface "what is Santi's Mac
  // doing right now". Rolling window: we keep the last 288 rows per
  // device (one per 5-min interval = 24 h); older rows are pruned in
  // the WebSocket handler right after each insert.
  d.exec(`
    CREATE TABLE IF NOT EXISTS companion_activity (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   TEXT NOT NULL,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      active_app  TEXT,
      idle_secs   INTEGER,
      screen_on   INTEGER,
      battery_pct INTEGER,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_companion_activity_device
      ON companion_activity (device_id, recorded_at DESC);
  `);

  backfillTeamProjectAccess(d);
}

/**
 * Layer 5 topic detail view was showing user-only threads because
 * Layer 1 detection only tags user messages. This backfill walks every
 * assistant row in spar_messages and copies the immediately-preceding
 * user message's topic attachments onto it. Idempotent on
 * (topic_id, message_id) thanks to the join table's PK. Marker is
 * recorded in app_migrations so the walk runs at most once per
 * install.
 */
function backfillAssistantTopicLinks(d: Database.Database) {
  const MIGRATION = "assistant_topic_links_backfill_v1";
  const already = d
    .prepare("SELECT 1 FROM app_migrations WHERE name = ?")
    .get(MIGRATION);
  if (already) return;

  // For each assistant row, find the prior user row in the same
  // conversation, then INSERT OR IGNORE every topic attachment of
  // that user row onto the assistant row. Done in one SQL pass so the
  // entire backfill stays inside a single transaction — no N+1.
  const insertSql = `
    INSERT OR IGNORE INTO spar_message_topics (topic_id, message_id, relevance, created_at)
    SELECT mt.topic_id, a.id, mt.relevance, ?
      FROM spar_messages a
      JOIN spar_messages u
        ON u.conversation_id = a.conversation_id
       AND u.role = 'user'
       AND u.id = (
         SELECT MAX(u2.id) FROM spar_messages u2
          WHERE u2.conversation_id = a.conversation_id
            AND u2.role = 'user'
            AND u2.id < a.id
       )
      JOIN spar_message_topics mt ON mt.message_id = u.id
     WHERE a.role = 'assistant'
  `;
  const now = Date.now();
  d.transaction(() => {
    const info = d.prepare(insertSql).run(now);
    d.prepare("INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)").run(
      MIGRATION,
      now,
    );
    console.log(
      `[db] backfillAssistantTopicLinks: inserted ${info.changes} assistant→topic links`,
    );
  })();
}

/**
 * One-shot backfill: every existing non-task conversation gets a
 * daily_chats row keyed by its created_at date in Europe/Amsterdam.
 * Within a single (user, date_local) bucket the most-recently-updated
 * conversation is marked active=1; older same-day conversations get
 * active=0 so they remain accessible from the sidebar without
 * intercepting new writes. Idempotent via app_migrations marker —
 * runs at most once per install.
 *
 * Edge case: if a date_local already has an active=1 row from a real
 * (non-backfilled) write that landed before this migration ran, the
 * partial UNIQUE index fires and the INSERT OR IGNORE keeps the
 * pre-existing row. The losing row falls through and gets re-inserted
 * with active=0 in the second pass below.
 */
function backfillDailyChats(d: Database.Database) {
  const MIGRATION = "daily_chats_backfill_v1";
  const already = d
    .prepare("SELECT 1 FROM app_migrations WHERE name = ?")
    .get(MIGRATION);
  if (already) return;

  // Local import to avoid module-load order issues — lib/local-date is
  // pure JS and has no transitive deps on this file.
  const { formatLocalDate } = require("./local-date") as typeof import("./local-date");

  type Row = { id: number; user_id: number; created_at: number; updated_at: number };
  const convs = d
    .prepare(
      "SELECT id, user_id, created_at, updated_at FROM spar_conversations WHERE task_id IS NULL",
    )
    .all() as Row[];

  // Group by (user, date_local) and pick the most-recently-updated as active.
  const groups = new Map<string, Row[]>();
  for (const c of convs) {
    const date = formatLocalDate(c.created_at);
    const key = `${c.user_id} ${date}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const insertActive = d.prepare(
    "INSERT OR IGNORE INTO daily_chats (user_id, date_local, conversation_id, active, created_at) VALUES (?, ?, ?, 1, ?)",
  );
  const insertInactive = d.prepare(
    "INSERT OR IGNORE INTO daily_chats (user_id, date_local, conversation_id, active, created_at) VALUES (?, ?, ?, 0, ?)",
  );
  const mark = d.prepare(
    "INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)",
  );

  d.transaction(() => {
    for (const [key, list] of groups) {
      const sep = key.indexOf(" ");
      const userId = Number(key.slice(0, sep));
      const date = key.slice(sep + 1);
      list.sort((a, b) => b.updated_at - a.updated_at);
      // First insert as active. If the partial UNIQUE index rejects
      // (because something already wrote an active row for this
      // bucket between feature deploy and migration), fall through.
      insertActive.run(userId, date, list[0].id, list[0].created_at);
      for (let i = 1; i < list.length; i++) {
        insertInactive.run(userId, date, list[i].id, list[i].created_at);
      }
    }
    mark.run(MIGRATION, Date.now());
  })();
}

/**
 * Until now, role='team' bypassed project_access entirely and saw every
 * configured project. We now treat team like client (project-scoped via
 * project_access). Without a backfill, every existing team member would
 * suddenly see zero projects after this deploy. So on first boot under
 * the new semantics, grant each existing team user access to every
 * currently-configured project — preserving today's behavior. Admins
 * can then narrow scope explicitly. Marker row in app_migrations
 * makes this strictly one-shot; new team members created after the
 * migration start with no access until an admin assigns projects
 * (matches the new contract: empty rows = sees nothing).
 */
function backfillTeamProjectAccess(d: Database.Database) {
  const MIGRATION = "team_project_access_backfill_v1";
  const already = d
    .prepare("SELECT 1 FROM app_migrations WHERE name = ?")
    .get(MIGRATION);
  if (already) return;

  let projectIds: string[];
  try {
    projectIds = loadConfig().projects.map((p) => p.id);
  } catch (err) {
    // If the config can't be loaded right now (corrupt JSON, missing
    // file), don't mark the migration done — try again next boot.
    console.warn(
      "[db] backfillTeamProjectAccess skipped: loadConfig failed:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const teamUsers = d
    .prepare("SELECT id FROM users WHERE role = 'team'")
    .all() as { id: number }[];

  const ins = d.prepare(
    "INSERT OR IGNORE INTO project_access (user_id, project_id) VALUES (?, ?)",
  );
  const mark = d.prepare(
    "INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)",
  );

  d.transaction(() => {
    for (const u of teamUsers) {
      for (const pid of projectIds) ins.run(u.id, pid);
    }
    mark.run(MIGRATION, Date.now());
  })();
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
