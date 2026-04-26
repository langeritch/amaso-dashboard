import { getDb } from "./db";

export type AutomationKind = "url";

export interface UrlPayload {
  url: string;
}

export interface Automation {
  id: number;
  name: string;
  description: string | null;
  kind: AutomationKind;
  payload: UrlPayload;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationStats {
  // Most recent recording_sessions.started_at across runs of this
  // automation. NULL when the automation has never been launched.
  lastRunAt: number | null;
  // Total number of distinct recording sessions tagged with this
  // automation_id.
  runCount: number;
  // Sessions whose post-recording analysis ended in 'failed'.
  failedRuns: number;
  // Sum of recording_events.needs_clarification = 1 across this
  // automation's sessions. Granular event-level signal — useful for
  // spotting flaky steps even when no run formally errored.
  clarificationsNeeded: number;
}

export interface AutomationWithStats extends Automation {
  stats: AutomationStats;
}

interface AutomationRow {
  id: number;
  name: string;
  description: string | null;
  kind: AutomationKind;
  payload_json: string;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

function rowToAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as UrlPayload,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAutomations(): Automation[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM automations ORDER BY sort_order ASC, id ASC",
    )
    .all() as AutomationRow[];
  return rows.map(rowToAutomation);
}

interface AutomationStatsRow {
  automation_id: number;
  last_run_at: number | null;
  run_count: number;
  failed_runs: number;
  clarifications_needed: number;
}

/**
 * Single-pass stats join. We compute clarifications via a subquery so
 * the LEFT JOIN to recording_events doesn't multiply session rows and
 * inflate run_count / failed_runs.
 */
export function listAutomationsWithStats(): AutomationWithStats[] {
  const db = getDb();
  const automations = listAutomations();
  if (automations.length === 0) return [];

  const statsRows = db
    .prepare(
      `SELECT
         s.automation_id                                  AS automation_id,
         MAX(s.started_at)                                AS last_run_at,
         COUNT(*)                                         AS run_count,
         SUM(CASE WHEN s.analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
         COALESCE((
           SELECT SUM(e.needs_clarification)
             FROM recording_events e
             JOIN recording_sessions s2 ON s2.id = e.session_id
            WHERE s2.automation_id = s.automation_id
         ), 0)                                            AS clarifications_needed
       FROM recording_sessions s
      WHERE s.automation_id IS NOT NULL
      GROUP BY s.automation_id`,
    )
    .all() as AutomationStatsRow[];

  const byId = new Map<number, AutomationStatsRow>();
  for (const r of statsRows) byId.set(r.automation_id, r);

  return automations.map((a) => {
    const r = byId.get(a.id);
    const stats: AutomationStats = r
      ? {
          lastRunAt: r.last_run_at,
          runCount: r.run_count,
          failedRuns: r.failed_runs,
          clarificationsNeeded: r.clarifications_needed,
        }
      : {
          lastRunAt: null,
          runCount: 0,
          failedRuns: 0,
          clarificationsNeeded: 0,
        };
    return { ...a, stats };
  });
}

export interface CreateAutomationInput {
  name: string;
  description: string | null;
  kind: AutomationKind;
  payload: UrlPayload;
}

export function createAutomation(input: CreateAutomationInput): Automation {
  const db = getDb();
  const now = Date.now();
  // New rows go to the end of the list.
  const maxSort = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM automations")
    .get() as { m: number };
  const result = db
    .prepare(
      "INSERT INTO automations (name, description, kind, payload_json, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
    )
    .run(
      input.name,
      input.description,
      input.kind,
      JSON.stringify(input.payload),
      maxSort.m + 1,
      now,
      now,
    );
  return getAutomation(Number(result.lastInsertRowid))!;
}

export interface PatchAutomationInput {
  name?: string;
  description?: string | null;
  payload?: UrlPayload;
  enabled?: boolean;
}

export function patchAutomation(
  id: number,
  patch: PatchAutomationInput,
): Automation | null {
  const db = getDb();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    args.push(patch.description);
  }
  if (patch.payload !== undefined) {
    sets.push("payload_json = ?");
    args.push(JSON.stringify(patch.payload));
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    args.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return getAutomation(id);
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  const res = db
    .prepare(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args);
  if (res.changes === 0) return null;
  return getAutomation(id);
}

export function deleteAutomation(id: number): boolean {
  const res = getDb().prepare("DELETE FROM automations WHERE id = ?").run(id);
  return res.changes > 0;
}

export function getAutomationStats(id: number): AutomationStats {
  const row = getDb()
    .prepare(
      `SELECT
         MAX(s.started_at)                                AS last_run_at,
         COUNT(*)                                         AS run_count,
         SUM(CASE WHEN s.analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
         COALESCE((
           SELECT SUM(e.needs_clarification)
             FROM recording_events e
             JOIN recording_sessions s2 ON s2.id = e.session_id
            WHERE s2.automation_id = ?
         ), 0)                                            AS clarifications_needed
       FROM recording_sessions s
      WHERE s.automation_id = ?`,
    )
    .get(id, id) as {
    last_run_at: number | null;
    run_count: number | null;
    failed_runs: number | null;
    clarifications_needed: number | null;
  };
  return {
    lastRunAt: row.last_run_at ?? null,
    runCount: row.run_count ?? 0,
    failedRuns: row.failed_runs ?? 0,
    clarificationsNeeded: row.clarifications_needed ?? 0,
  };
}

export function getAutomation(id: number): Automation | null {
  const row = getDb()
    .prepare("SELECT * FROM automations WHERE id = ?")
    .get(id) as AutomationRow | undefined;
  return row ? rowToAutomation(row) : null;
}
