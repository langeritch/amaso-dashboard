import { getDb } from "./db";
import { loadConfig, type ProjectConfig } from "./config";
import type { User } from "./db";

/**
 * Which projects this user is allowed to see?
 *  - admin / team → all projects from amaso.config.json
 *  - client       → only projects explicitly granted in `project_access`
 *
 * If loadConfig() throws (corrupt JSON, missing file, weird cwd) we treat
 * that as "no projects visible right now" rather than crashing the page —
 * an admin sees an empty list with a console.warn instead of a 500. The
 * normal restart cycle re-reads from disk, so a transient EPERM on the
 * config file recovers on the next request.
 */
export function visibleProjects(user: User): ProjectConfig[] {
  let all: ProjectConfig[];
  try {
    all = loadConfig().projects;
  } catch (err) {
    console.warn(
      `[access] visibleProjects loadConfig failed (user=${user.id} role=${user.role}):`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
  if (user.role === "admin" || user.role === "team") return all;
  const rows = getDb()
    .prepare("SELECT project_id FROM project_access WHERE user_id = ?")
    .all(user.id) as { project_id: string }[];
  const allowed = new Set(rows.map((r) => r.project_id));
  return all.filter((p) => allowed.has(p.id));
}

/**
 * Admin/team always pass — they're trusted to operate on any project,
 * including ones added since this Node process booted. Earlier this
 * function gated admin access on `loadConfig().projects.some(...)` as a
 * sanity check, but that turned into a load-bearing existence test:
 * a stale config read or a project removed mid-session would surface
 * to operators as a misleading "no access to this project" error
 * (reported by Ilias + Santi after a config edit). Downstream code
 * (getProject, getSession, dispatchToProject) already handles unknown
 * project ids cleanly, so we drop the gate here and let admins through.
 *
 * Clients keep going through the project_access table.
 */
export function canAccessProject(user: User, projectId: string): boolean {
  if (user.role === "admin" || user.role === "team") return true;
  const row = getDb()
    .prepare(
      "SELECT 1 FROM project_access WHERE user_id = ? AND project_id = ?",
    )
    .get(user.id, projectId);
  return Boolean(row);
}

export function setProjectAccess(userId: number, projectIds: string[]) {
  const db = getDb();
  const del = db.prepare("DELETE FROM project_access WHERE user_id = ?");
  const ins = db.prepare(
    "INSERT OR IGNORE INTO project_access (user_id, project_id) VALUES (?, ?)",
  );
  db.transaction(() => {
    del.run(userId);
    for (const pid of projectIds) ins.run(userId, pid);
  })();
}

export function getProjectAccess(userId: number): string[] {
  return (
    getDb()
      .prepare("SELECT project_id FROM project_access WHERE user_id = ?")
      .all(userId) as { project_id: string }[]
  ).map((r) => r.project_id);
}
