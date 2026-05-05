// Per-user autopilot state. Autopilot is no longer a server-side cron
// dispatcher — it is a mode switch that changes the prompt the
// auto-report path sends when a dispatched terminal goes idle. The
// `autopilot_users` row holds the on/off bit (`enabled`) plus the
// strategic `directive` the autonomous loop reads when picking and
// creating tasks. Saving a directive while autopilot is off is allowed:
// the directive persists across toggles so the user can prep the
// north-star prompt before flipping the switch.

import { getDb } from "./db";

interface AutopilotRow {
  user_id: number;
  enabled_at: number;
  enabled: number;
  directive: string | null;
}

function loadRow(userId: number): AutopilotRow | undefined {
  return getDb()
    .prepare(
      "SELECT user_id, enabled_at, enabled, directive FROM autopilot_users WHERE user_id = ?",
    )
    .get(userId) as AutopilotRow | undefined;
}

export function isAutopilotEnabled(userId: number): boolean {
  const row = loadRow(userId);
  return Boolean(row && row.enabled === 1);
}

export function enableAutopilot(userId: number): void {
  const db = getDb();
  const now = Date.now();
  const exists = loadRow(userId);
  if (exists) {
    db.prepare(
      "UPDATE autopilot_users SET enabled = 1, enabled_at = ? WHERE user_id = ?",
    ).run(now, userId);
  } else {
    db.prepare(
      "INSERT INTO autopilot_users (user_id, enabled_at, enabled) VALUES (?, ?, 1)",
    ).run(userId, now);
  }
}

export function disableAutopilot(userId: number): void {
  // Keep the row so the directive survives the off-switch; just flip
  // the bit. If the user has never set a directive there's no harm in
  // leaving the (otherwise empty) row behind either.
  getDb()
    .prepare("UPDATE autopilot_users SET enabled = 0 WHERE user_id = ?")
    .run(userId);
}

/** The user's strategic directive for the autonomous loop. Empty
 *  string when no directive is set. Independent of the on/off toggle. */
export function readAutopilotDirective(userId: number): string {
  const row = loadRow(userId);
  return row?.directive ?? "";
}

/** Upsert the directive without touching the on/off bit. New rows are
 *  created with enabled=0 so saving a directive does NOT auto-enable
 *  autopilot — the toggle stays the source of truth for that. */
export function writeAutopilotDirective(userId: number, directive: string): void {
  const trimmed = directive.trim();
  const db = getDb();
  const exists = loadRow(userId);
  if (exists) {
    db.prepare(
      "UPDATE autopilot_users SET directive = ? WHERE user_id = ?",
    ).run(trimmed || null, userId);
  } else {
    db.prepare(
      "INSERT INTO autopilot_users (user_id, enabled_at, enabled, directive) VALUES (?, ?, 0, ?)",
    ).run(userId, Date.now(), trimmed || null);
  }
}
