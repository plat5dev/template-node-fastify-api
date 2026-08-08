import type { Db } from "../db.js"
import { trackDb } from "../db.js"
import type { Task } from "../schemas/common.js"

export class TasksStore {
  constructor(private readonly db: Db) {}

  listByProject(organizationId: string, projectId: string): Task[] {
    return trackDb("tasks.list", () => {
      return this.db
        .prepare(
          `SELECT id, organization_id, project_id, title, status, created_by_membership_id, created_at, updated_at
           FROM tasks WHERE organization_id = ? AND project_id = ?
           ORDER BY created_at DESC`
        )
        .all(organizationId, projectId) as Task[]
    })
  }

  findInProject(
    organizationId: string,
    projectId: string,
    taskId: string
  ): Task | null {
    return trackDb("tasks.find", () => {
      const row = this.db
        .prepare(
          `SELECT id, organization_id, project_id, title, status, created_by_membership_id, created_at, updated_at
           FROM tasks WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .get(taskId, organizationId, projectId) as Task | undefined
      return row ?? null
    })
  }

  insert(t: Task): void {
    trackDb("tasks.insert", () => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, organization_id, project_id, title, status, created_by_membership_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          t.id,
          t.organization_id,
          t.project_id,
          t.title,
          t.status,
          t.created_by_membership_id,
          t.created_at,
          t.updated_at
        )
    })
  }

  update(t: Task): void {
    trackDb("tasks.update", () => {
      this.db
        .prepare(
          `UPDATE tasks SET title = ?, status = ?, updated_at = ?
           WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .run(
          t.title,
          t.status,
          t.updated_at,
          t.id,
          t.organization_id,
          t.project_id
        )
    })
  }

  delete(organizationId: string, projectId: string, taskId: string): boolean {
    return trackDb("tasks.delete", () => {
      const res = this.db
        .prepare(
          `DELETE FROM tasks WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .run(taskId, organizationId, projectId)
      return res.changes > 0
    })
  }
}
