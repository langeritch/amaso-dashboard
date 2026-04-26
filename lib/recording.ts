import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
  RecordingAnalysisStatus,
  RecordingEvent,
  RecordingSession,
  StoredRecordingEvent,
} from "@/types/recording";

interface SessionRow {
  id: string;
  user_id: number;
  started_at: number;
  ended_at: number | null;
  status: "active" | "ended";
  name: string | null;
  analysis_status: RecordingAnalysisStatus | null;
  analysis_result: string | null;
  automation_id: number | null;
}

interface EventRow {
  id: number;
  session_id: string;
  client_id: string;
  type: RecordingEvent["type"];
  timestamp: number;
  url: string;
  title: string | null;
  target_json: string | null;
  value: string | null;
  needs_clarification: number;
  clarification_reason: string | null;
  clarification: string | null;
}

interface SessionAggRow {
  id: string;
  user_id: number;
  started_at: number;
  ended_at: number | null;
  status: "active" | "ended";
  name: string | null;
  analysis_status: RecordingAnalysisStatus | null;
  analysis_result: string | null;
  automation_id: number | null;
  event_count: number;
  needs_clarification_count: number;
}

function rowToSession(row: SessionAggRow): RecordingSession {
  return {
    id: row.id,
    userId: row.user_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    name: row.name,
    analysisStatus: row.analysis_status,
    analysisResult: row.analysis_result,
    eventCount: row.event_count,
    needsClarificationCount: row.needs_clarification_count,
    automationId: row.automation_id,
  };
}

function rowToEvent(row: EventRow): StoredRecordingEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    clientId: row.client_id,
    type: row.type,
    timestamp: row.timestamp,
    url: row.url,
    title: row.title,
    target: row.target_json
      ? (JSON.parse(row.target_json) as StoredRecordingEvent["target"])
      : null,
    value: row.value,
    needs_clarification: row.needs_clarification === 1,
    clarification_reason: row.clarification_reason,
    clarification: row.clarification,
  };
}

export function createSession(
  userId: number,
  automationId: number | null = null,
): RecordingSession {
  const d = getDb();
  const id = randomUUID();
  const now = Date.now();
  d.prepare(
    `INSERT INTO recording_sessions (id, user_id, started_at, status, automation_id)
     VALUES (?, ?, ?, 'active', ?)`,
  ).run(id, userId, now, automationId);
  return {
    id,
    userId,
    startedAt: now,
    endedAt: null,
    status: "active",
    name: null,
    analysisStatus: null,
    analysisResult: null,
    eventCount: 0,
    needsClarificationCount: 0,
    automationId,
  };
}

export function endSession(id: string, userId: number): RecordingSession | null {
  const d = getDb();
  const row = d
    .prepare(`SELECT * FROM recording_sessions WHERE id = ? AND user_id = ?`)
    .get(id, userId) as SessionRow | undefined;
  if (!row) return null;
  if (row.status === "active") {
    d.prepare(
      `UPDATE recording_sessions SET status = 'ended', ended_at = ? WHERE id = ?`,
    ).run(Date.now(), id);
  }
  return getSession(id, userId);
}

export function getSession(id: string, userId: number): RecordingSession | null {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT s.id, s.user_id, s.started_at, s.ended_at, s.status,
              s.name, s.analysis_status, s.analysis_result, s.automation_id,
              COUNT(e.id) AS event_count,
              COALESCE(SUM(e.needs_clarification), 0) AS needs_clarification_count
         FROM recording_sessions s
         LEFT JOIN recording_events e ON e.session_id = s.id
        WHERE s.id = ? AND s.user_id = ?
        GROUP BY s.id`,
    )
    .get(id, userId) as SessionAggRow | undefined;
  return row ? rowToSession(row) : null;
}

export function listSessions(userId: number, limit = 50): RecordingSession[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT s.id, s.user_id, s.started_at, s.ended_at, s.status,
              s.name, s.analysis_status, s.analysis_result, s.automation_id,
              COUNT(e.id) AS event_count,
              COALESCE(SUM(e.needs_clarification), 0) AS needs_clarification_count
         FROM recording_sessions s
         LEFT JOIN recording_events e ON e.session_id = s.id
        WHERE s.user_id = ?
        GROUP BY s.id
        ORDER BY s.started_at DESC
        LIMIT ?`,
    )
    .all(userId, limit) as SessionAggRow[];
  return rows.map(rowToSession);
}

export function listEvents(sessionId: string): StoredRecordingEvent[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT * FROM recording_events
        WHERE session_id = ?
        ORDER BY timestamp ASC, id ASC`,
    )
    .all(sessionId) as EventRow[];
  return rows.map(rowToEvent);
}

export interface AppendEventsResult {
  appended: number;
  skipped: number;
}

export function appendEvents(
  sessionId: string,
  userId: number,
  events: RecordingEvent[],
): AppendEventsResult | null {
  const d = getDb();
  // Authorize: session must exist and belong to user. Active OR ended is
  // both fine — ended sessions still accept tail events from a slow
  // flush, but the UI stops sending once the user has clicked stop.
  const owner = d
    .prepare(`SELECT user_id FROM recording_sessions WHERE id = ?`)
    .get(sessionId) as { user_id: number } | undefined;
  if (!owner || owner.user_id !== userId) return null;

  const insert = d.prepare(
    `INSERT OR IGNORE INTO recording_events
       (session_id, client_id, type, timestamp, url, title,
        target_json, value, needs_clarification, clarification_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let appended = 0;
  let skipped = 0;
  const tx = d.transaction((batch: RecordingEvent[]) => {
    for (const ev of batch) {
      const res = insert.run(
        sessionId,
        ev.clientId,
        ev.type,
        ev.timestamp,
        ev.url,
        ev.title,
        ev.target ? JSON.stringify(ev.target) : null,
        ev.value,
        ev.needs_clarification ? 1 : 0,
        ev.clarification_reason,
      );
      if (res.changes > 0) appended++;
      else skipped++;
    }
  });
  tx(events);
  return { appended, skipped };
}

export function setEventClarification(
  eventId: number,
  userId: number,
  clarification: string,
): StoredRecordingEvent | null {
  const d = getDb();
  // Verify ownership through the session join.
  const row = d
    .prepare(
      `SELECT e.* FROM recording_events e
         JOIN recording_sessions s ON s.id = e.session_id
        WHERE e.id = ? AND s.user_id = ?`,
    )
    .get(eventId, userId) as EventRow | undefined;
  if (!row) return null;
  d.prepare(`UPDATE recording_events SET clarification = ? WHERE id = ?`).run(
    clarification,
    eventId,
  );
  return rowToEvent({ ...row, clarification });
}

export function setSessionName(
  id: string,
  userId: number,
  name: string | null,
): RecordingSession | null {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT user_id FROM recording_sessions WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as { user_id: number } | undefined;
  if (!row) return null;
  // Empty string is treated as "cleared" — store NULL so downstream
  // consumers don't have to distinguish between "" and unset.
  const trimmed = name == null ? null : name.trim();
  const stored = trimmed && trimmed.length > 0 ? trimmed : null;
  d.prepare(`UPDATE recording_sessions SET name = ? WHERE id = ?`).run(
    stored,
    id,
  );
  return getSession(id, userId);
}

/**
 * Tag an in-progress session with the automation that launched it.
 * First-write wins — if the user clicks several launcher cards before
 * stopping the recording, only the first one is attributed so the
 * stats reflect the actual entry point.
 */
export function setSessionAutomation(
  id: string,
  userId: number,
  automationId: number | null,
): RecordingSession | null {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT user_id, automation_id FROM recording_sessions WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as
    | { user_id: number; automation_id: number | null }
    | undefined;
  if (!row) return null;
  if (row.automation_id == null && automationId != null) {
    d.prepare(`UPDATE recording_sessions SET automation_id = ? WHERE id = ?`).run(
      automationId,
      id,
    );
  }
  return getSession(id, userId);
}

export function setAnalysisStatus(
  id: string,
  userId: number,
  status: RecordingAnalysisStatus | null,
  result: string | null = null,
): RecordingSession | null {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT user_id FROM recording_sessions WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as { user_id: number } | undefined;
  if (!row) return null;
  d.prepare(
    `UPDATE recording_sessions
        SET analysis_status = ?, analysis_result = ?
      WHERE id = ?`,
  ).run(status, result, id);
  return getSession(id, userId);
}

/**
 * Hard-delete a session and all its events. Used by the end-of-session
 * "Discard" action — the user never wants this data again. ON DELETE
 * CASCADE on recording_events takes care of the child rows.
 */
export function deleteSession(id: string, userId: number): boolean {
  const d = getDb();
  const res = d
    .prepare(`DELETE FROM recording_sessions WHERE id = ? AND user_id = ?`)
    .run(id, userId);
  return res.changes > 0;
}

/**
 * Find the user's currently-active session, if any. The header toggle
 * uses this on mount to restore its visual state across page reloads.
 */
export function findActiveSession(userId: number): RecordingSession | null {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT s.id, s.user_id, s.started_at, s.ended_at, s.status,
              s.name, s.analysis_status, s.analysis_result, s.automation_id,
              COUNT(e.id) AS event_count,
              COALESCE(SUM(e.needs_clarification), 0) AS needs_clarification_count
         FROM recording_sessions s
         LEFT JOIN recording_events e ON e.session_id = s.id
        WHERE s.user_id = ? AND s.status = 'active'
        GROUP BY s.id
        ORDER BY s.started_at DESC
        LIMIT 1`,
    )
    .get(userId) as SessionAggRow | undefined;
  return row ? rowToSession(row) : null;
}
