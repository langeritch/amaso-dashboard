// Append-only audit log for security-sensitive admin actions.
//
// Writes go through `recordAudit()`. Reads (when we eventually build a
// UI for this) should NEVER use a path that allows DELETE / UPDATE —
// the table is logically append-only and we treat it that way at the
// API layer, since SQLite has no ROW-LEVEL append-only enforcement.
//
// We capture identifying info (email, ip) at write time so the trail
// survives downstream user renames / deletions.

import { getDb } from "./db";

export type AuditAction =
  | "auth.login.success"
  | "auth.login.failed"
  | "auth.setup.created_admin"
  | "auth.magic_link.requested"
  | "auth.magic_link.success"
  | "auth.magic_link.failed"
  | "user.created"
  | "user.updated"
  | "user.deleted"
  | "user.role_changed"
  | "user.password_reset"
  | "user.password_changed"
  | "session.destroyed"
  | "claude_account.added"
  | "claude_account.removed"
  | "claude_account.activated"
  | "project.access_granted"
  | "project.access_revoked"
  | "terminal.session_started"
  | "terminal.session_killed"
  | "editor.document.created"
  | "editor.commit.created"
  | "companion.renamed";

export interface AuditEntry {
  action: AuditAction;
  actorId?: number | null;
  actorEmail?: string | null;
  actorIp?: string | null;
  targetKind?: string | null;
  targetId?: string | number | null;
  targetEmail?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Write one audit entry. Safe to call from anywhere; failures are
 *  swallowed (logged to stderr) so the audit subsystem can never
 *  block a legit admin action — that would be a worse outcome than
 *  a missed log line. */
export function recordAudit(entry: AuditEntry): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO audit_log
         (ts, actor_id, actor_email, actor_ip, action,
          target_kind, target_id, target_email, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      entry.actorId ?? null,
      entry.actorEmail ?? null,
      entry.actorIp ?? null,
      entry.action,
      entry.targetKind ?? null,
      entry.targetId == null ? null : String(entry.targetId),
      entry.targetEmail ?? null,
      entry.meta ? JSON.stringify(entry.meta) : null,
    );
  } catch (err) {
    // Audit logging must not break user-facing actions. Surface to
    // stderr so the watchdog log captures it for forensics.
    console.error("[audit] failed to record entry", entry.action, err);
  }
}

export interface AuditQueryOptions {
  action?: AuditAction;
  actorId?: number;
  sinceMs?: number;
  limit?: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  actorId: number | null;
  actorEmail: string | null;
  actorIp: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  targetEmail: string | null;
  meta: Record<string, unknown> | null;
}

/**
 * Sweep audit rows older than the configured retention window.
 *
 * The audit log is logically append-only at the app layer (no
 * deleteAudit / updateAudit export). Retention is the one exception:
 * a long-lived dashboard with lots of login activity would otherwise
 * grow the DB indefinitely. Default retention is 365 days, override
 * via AUDIT_RETENTION_DAYS env var. Set to 0 to disable.
 *
 * Idempotent and safe to call from a cron / boot hook. Returns the
 * number of rows deleted so the caller can log it.
 */
export function pruneAuditLog(): { deleted: number } {
  const days = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);
  if (!Number.isFinite(days) || days <= 0) return { deleted: 0 };
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const info = getDb()
      .prepare("DELETE FROM audit_log WHERE ts < ?")
      .run(cutoff);
    return { deleted: info.changes };
  } catch (err) {
    console.error("[audit] pruneAuditLog failed", err);
    return { deleted: 0 };
  }
}

/** Read recent audit entries. Read-only by design; there is intentionally
 *  no deleteAudit / updateAudit export. Retention sweep
 *  (pruneAuditLog) is the only mutation path and runs only by operator
 *  schedule, not by user request. */
export function queryAudit(opts: AuditQueryOptions = {}): AuditRow[] {
  const db = getDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.action) {
    where.push("action = ?");
    args.push(opts.action);
  }
  if (typeof opts.actorId === "number") {
    where.push("actor_id = ?");
    args.push(opts.actorId);
  }
  if (typeof opts.sinceMs === "number") {
    where.push("ts >= ?");
    args.push(opts.sinceMs);
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const sql = `SELECT id, ts, actor_id, actor_email, actor_ip, action,
                      target_kind, target_id, target_email, meta_json
                 FROM audit_log
                ${where.length ? "WHERE " + where.join(" AND ") : ""}
                ORDER BY id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit) as Array<{
    id: number;
    ts: number;
    actor_id: number | null;
    actor_email: string | null;
    actor_ip: string | null;
    action: string;
    target_kind: string | null;
    target_id: string | null;
    target_email: string | null;
    meta_json: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actorId: r.actor_id,
    actorEmail: r.actor_email,
    actorIp: r.actor_ip,
    action: r.action,
    targetKind: r.target_kind,
    targetId: r.target_id,
    targetEmail: r.target_email,
    meta: r.meta_json
      ? (JSON.parse(r.meta_json) as Record<string, unknown>)
      : null,
  }));
}
