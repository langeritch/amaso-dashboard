import { getDb } from "./db";

/**
 * Per-project roadmap: hierarchical checklist of steps.
 *
 * Two levels in the UI (step → sub-step) but the schema allows
 * arbitrary depth — each row carries a nullable `parent_id`. Order
 * within a parent (or among top-level rows when parent_id is NULL)
 * is driven by `position`, which the create-step path auto-assigns
 * to one past the current max so new rows append at the bottom.
 */

export interface RoadmapStep {
  id: number;
  projectId: string;
  parentId: number | null;
  position: number;
  title: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

interface RoadmapStepRow {
  id: number;
  project_id: string;
  parent_id: number | null;
  position: number;
  title: string;
  done: number;
  created_at: number;
  updated_at: number;
}

function rowToStep(r: RoadmapStepRow): RoadmapStep {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id,
    position: r.position,
    title: r.title,
    done: r.done === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** All steps for a project, ordered by parent then position. */
export function listRoadmapSteps(projectId: string): RoadmapStep[] {
  const rows = getDb()
    .prepare(
      // NULLs first (top-level), then by parent so siblings are
      // grouped, then by position within each group.
      `SELECT id, project_id, parent_id, position, title, done, created_at, updated_at
         FROM roadmap_steps
        WHERE project_id = ?
        ORDER BY (parent_id IS NULL) DESC, parent_id ASC, position ASC, id ASC`,
    )
    .all(projectId) as RoadmapStepRow[];
  return rows.map(rowToStep);
}

export function getRoadmapStep(stepId: number): RoadmapStep | null {
  const row = getDb()
    .prepare(
      `SELECT id, project_id, parent_id, position, title, done, created_at, updated_at
         FROM roadmap_steps WHERE id = ?`,
    )
    .get(stepId) as RoadmapStepRow | undefined;
  return row ? rowToStep(row) : null;
}

export function createRoadmapStep(opts: {
  projectId: string;
  parentId: number | null;
  title: string;
}): RoadmapStep {
  const db = getDb();
  // If parentId is given, validate it belongs to the same project.
  // Without this, a malicious client could parent a step under
  // another project's row. parent_id is NULLable for top-level steps.
  if (opts.parentId !== null) {
    const parent = db
      .prepare("SELECT project_id FROM roadmap_steps WHERE id = ?")
      .get(opts.parentId) as { project_id: string } | undefined;
    if (!parent || parent.project_id !== opts.projectId) {
      throw new Error("invalid_parent");
    }
  }
  // Append at the end of the parent group.
  const maxRow = db
    .prepare(
      `SELECT COALESCE(MAX(position), -1) AS max_pos
         FROM roadmap_steps
        WHERE project_id = ?
          AND parent_id IS ?`,
    )
    .get(opts.projectId, opts.parentId) as { max_pos: number };
  const position = (maxRow?.max_pos ?? -1) + 1;
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO roadmap_steps
         (project_id, parent_id, position, title, done, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      opts.projectId,
      opts.parentId,
      position,
      opts.title.trim(),
      now,
      now,
    );
  return getRoadmapStep(Number(info.lastInsertRowid))!;
}

export function updateRoadmapStep(
  stepId: number,
  patch: { title?: string; done?: boolean },
): RoadmapStep | null {
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (patch.title !== undefined) {
    fields.push("title = ?");
    values.push(patch.title.trim());
  }
  if (patch.done !== undefined) {
    fields.push("done = ?");
    values.push(patch.done ? 1 : 0);
  }
  if (fields.length === 0) return getRoadmapStep(stepId);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(stepId);
  getDb()
    .prepare(`UPDATE roadmap_steps SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getRoadmapStep(stepId);
}

export function deleteRoadmapStep(stepId: number): void {
  getDb().prepare("DELETE FROM roadmap_steps WHERE id = ?").run(stepId);
}
