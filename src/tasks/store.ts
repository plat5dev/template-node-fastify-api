import type { Db } from "../db.js"
import { trackDb } from "../db.js"
import { trim, type Page } from "../pagination.js"
import type { Task } from "../schemas/common.js"

const COLUMNS = "id, project_id, title, status, created_by, created_at, updated_at"

export class TasksStore {
  constructor(private readonly db: Db) {}

  /** One page of the project's tasks in id order, and whether there are more. */
  listByProject(projectId: string, page: Page): { items: Task[]; hasMore: boolean } {
    return trackDb("tasks.list", () => {
      const rows = this.db
        .prepare(
          `SELECT ${COLUMNS}
           FROM tasks WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`
        )
        .all(projectId, page.startingAfter, page.limit + 1) as Task[]
      return trim(rows, page)
    })
  }

  findInProject(projectId: string, taskId: string): Task | null {
    return trackDb("tasks.find", () => {
      const row = this.db
        .prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ? AND project_id = ?`)
        .get(taskId, projectId) as Task | undefined
      return row ?? null
    })
  }

  insert(t: Task): void {
    trackDb("tasks.insert", () => {
      this.db
        .prepare(`INSERT INTO tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          t.id,
          t.project_id,
          t.title,
          t.status,
          t.created_by,
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
           WHERE id = ? AND project_id = ?`
        )
        .run(t.title, t.status, t.updated_at, t.id, t.project_id)
    })
  }

  delete(projectId: string, taskId: string): void {
    trackDb("tasks.delete", () => {
      this.db
        .prepare(`DELETE FROM tasks WHERE id = ? AND project_id = ?`)
        .run(taskId, projectId)
    })
  }

  /**
   * Deletes every task of a project, for its purge. Deleting none is fine, so it can run
   * again for the same project.
   */
  deleteByProject(projectId: string): void {
    trackDb("tasks.delete_by_project", () => {
      this.db.prepare(`DELETE FROM tasks WHERE project_id = ?`).run(projectId)
    })
  }
}
