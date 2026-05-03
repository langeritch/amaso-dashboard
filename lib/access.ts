import { getDb } from "./db";
import { loadConfig, type ProjectConfig } from "./config";
import type { User } from "./db";

/**
 * Which projects this user is allowed to see?
 *  - admin / team → all projects
 *  - client       → only projects explicitly granted in `project_access`
 */
export function visibleProjects(user: User): ProjectConfig[] {
  const all = loadConfig().projects;
  if (user.role === "admin" || user.role === "team") return all;
  const rows = getDb()
    .prepare("SELECT project_id FROM project_access WHERE user_id = ?")
    .all(user.id) as { project_id: string }[];
  const allowed = new Set(rows.map((r) => r.project_id));
  return all.filter((p) => allowed.has(p.id));
}

export function canAccessProject(user: User, projectId: string): boolean {
  if (user.role === "admin" || user.role === "team") {
    return loadConfig().projects.some((p) => p.id === projectId);
  }
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
