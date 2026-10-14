import type { Db } from "../db.js"
import { trackDb } from "../db.js"
import { trim, type Page } from "../pagination.js"
import type { Task } from "../schemas/common.js"

export class TasksStore {
  constructor(private readonly db: Db) {}

  /** One page of the project's tasks in id order, and whether there are more. */
  listByProject(
    organizationId: string,
    projectId: string,
    page: Page
  ): { items: Task[]; hasMore: boolean } {
    return trackDb("tasks.list", () => {
      const rows = this.db
        .prepare(
          `SELECT id, organization_id, project_id, title, status, created_at, updated_at
           FROM tasks WHERE organization_id = ? AND project_id = ? AND id > ?
           ORDER BY id LIMIT ?`
        )
        .all(organizationId, projectId, page.startingAfter, page.limit + 1) as Task[]
      return trim(rows, page)
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
          `SELECT id, organization_id, project_id, title, status, created_at, updated_at
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
          `INSERT INTO tasks (id, organization_id, project_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          t.id,
          t.organization_id,
          t.project_id,
          t.title,
          t.status,
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
