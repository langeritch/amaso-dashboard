/**
 * Offline-resilient queue for companion commands.
 *
 * The dashboard's WS server fans commands out to whichever companion
 * sockets the user has open. If the user's companion happens to be
 * offline at dispatch time (laptop sleeping, transient network blip,
 * companion restarting), `sendCommand` would otherwise return an empty
 * ack list and the AI's instruction silently never runs. Queuing the
 * command in SQLite + flushing on the next connection turns the
 * "companion is briefly offline" case into "the action takes a few
 * seconds longer", which is the correct semantics for system-level
 * actions like opening an app or ducking audio.
 *
 * Persistence:
 *   - SQLite (not in-memory) so a dashboard restart between dispatch
 *     and reconnect doesn't lose commands.
 *   - TTL per row: stale commands are dropped rather than replayed, so
 *     the user doesn't get yesterday's "open Figma" the next time they
 *     plug the laptop in.
 *
 * Order:
 *   - Flushed in enqueued_at order. SQLite's INTEGER autoincrement gives
 *     us a tiebreaker for entries inserted at the same ms.
 *
 * Single-flush semantics:
 *   - Rows are deleted at the moment they're handed back to the WS
 *     layer for replay — companion-ws then re-sends them with their
 *     original wire id and waits for the same ack flow as a normal
 *     dispatch. If the companion drops mid-replay we don't re-queue:
 *     the dashboard will get a `socket closed` ack and decide whether
 *     it cares (most don't — the user already moved on).
 */

import type { CompanionCommand } from "./companion-ws";
import { getDb } from "./db";

/** Default TTL: a command sat for 5 minutes without delivery is
 *  almost certainly stale (user's intent has moved on, or the action
 *  was time-sensitive and is now meaningless). */
export const DEFAULT_QUEUE_TTL_MS = 5 * 60_000;

export interface QueuedCommand {
  /** Wire id reused on replay so callers correlating acks see the
   *  same value they got back from the original dispatch. */
  commandId: string;
  command: CompanionCommand;
  enqueuedAt: number;
}

interface QueueRow {
  id: number;
  user_id: number;
  command_id: string;
  command_json: string;
  enqueued_at: number;
  expires_at: number;
}

/** Add a command to the offline queue. Idempotent if called with the
 *  same `commandId` twice (most-recent payload wins) — the WS layer
 *  doesn't currently retry, but defensively unique-ing on (user, id)
 *  keeps us safe if it ever does. */
export function enqueueCommand(opts: {
  userId: number;
  commandId: string;
  command: CompanionCommand;
  ttlMs?: number;
  now?: number;
}): void {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_QUEUE_TTL_MS;
  const json = JSON.stringify(opts.command);
  const db = getDb();
  // Best-effort: if a row with the same (user, commandId) already
  // exists, replace it. Useful if a future caller re-tries a stale
  // dispatch with a fresh payload.
  db.prepare(
    `DELETE FROM companion_command_queue
     WHERE user_id = ? AND command_id = ?`,
  ).run(opts.userId, opts.commandId);
  db.prepare(
    `INSERT INTO companion_command_queue
       (user_id, command_id, command_json, enqueued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.userId, opts.commandId, json, now, now + ttl);
}

/**
 * Drain every non-expired queued command for the user, in order.
 * Atomically deletes the rows it returns — the WS layer is now on the
 * hook for delivery. Stale rows (expires_at <= now) are also deleted
 * silently to keep the table small.
 */
export function flushQueueForUser(
  userId: number,
  now: number = Date.now(),
): QueuedCommand[] {
  const db = getDb();
  // Drop expired rows first so the SELECT below returns only live
  // commands. This is the only place we GC the table — there's no
  // background sweeper, queueing is rare enough that piggy-backing
  // is fine.
  db.prepare(
    `DELETE FROM companion_command_queue
     WHERE expires_at <= ?`,
  ).run(now);

  const rows = db
    .prepare(
      `SELECT id, user_id, command_id, command_json, enqueued_at, expires_at
         FROM companion_command_queue
        WHERE user_id = ?
        ORDER BY enqueued_at ASC, id ASC`,
    )
    .all(userId) as QueueRow[];

  if (rows.length === 0) return [];

  // Single transaction for the dequeue so we either hand the caller
  // every row or none — partial drains during a crash would replay
  // half the queue twice on the next flush.
  const tx = db.transaction((rowIds: number[]) => {
    const stmt = db.prepare(
      `DELETE FROM companion_command_queue WHERE id = ?`,
    );
    for (const id of rowIds) stmt.run(id);
  });
  tx(rows.map((r) => r.id));

  const out: QueuedCommand[] = [];
  for (const r of rows) {
    let parsed: CompanionCommand;
    try {
      parsed = JSON.parse(r.command_json) as CompanionCommand;
    } catch {
      // Skip malformed rows — they're already deleted by the
      // transaction above, no need to log noisily.
      continue;
    }
    out.push({
      commandId: r.command_id,
      command: parsed,
      enqueuedAt: r.enqueued_at,
    });
  }
  return out;
}

/** Drop a queued command without replay — used when a stale dispatch
 *  is superseded by a fresh one (future use). */
export function removeQueuedCommand(userId: number, commandId: string): void {
  getDb()
    .prepare(
      `DELETE FROM companion_command_queue
       WHERE user_id = ? AND command_id = ?`,
    )
    .run(userId, commandId);
}

/** Diagnostic: how many commands are currently parked for the user.
 *  Used by the activity-feed entry to flag "command queued (offline)". */
export function queueDepthForUser(userId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM companion_command_queue
        WHERE user_id = ?`,
    )
    .get(userId) as { n: number };
  return row?.n ?? 0;
}
