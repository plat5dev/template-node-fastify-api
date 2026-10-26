import type { Db } from "../db.js"
import { trackDb } from "../db.js"
import { trim, type Page } from "../pagination.js"
import type { Task } from "../schemas/common.js"

const COLUMNS = "id, environment_id, title, status, created_by, created_at, updated_at"

export class TasksStore {
  constructor(private readonly db: Db) {}

  /** One page of the environment's tasks in id order, and whether there are more. */
  listByEnvironment(environmentId: string, page: Page): { items: Task[]; hasMore: boolean } {
    return trackDb("tasks.list", () => {
      const rows = this.db
        .prepare(
          `SELECT ${COLUMNS}
           FROM tasks WHERE environment_id = ? AND id > ? ORDER BY id LIMIT ?`
        )
        .all(environmentId, page.startingAfter, page.limit + 1) as Task[]
      return trim(rows, page)
    })
  }

  findInEnvironment(environmentId: string, taskId: string): Task | null {
    return trackDb("tasks.find", () => {
      const row = this.db
        .prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ? AND environment_id = ?`)
        .get(taskId, environmentId) as Task | undefined
      return row ?? null
    })
  }

  insert(t: Task): void {
    trackDb("tasks.insert", () => {
      this.db
        .prepare(`INSERT INTO tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          t.id,
          t.environment_id,
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
           WHERE id = ? AND environment_id = ?`
        )
        .run(t.title, t.status, t.updated_at, t.id, t.environment_id)
    })
  }

  delete(environmentId: string, taskId: string): void {
    trackDb("tasks.delete", () => {
      this.db
        .prepare(`DELETE FROM tasks WHERE id = ? AND environment_id = ?`)
        .run(taskId, environmentId)
    })
  }

  /**
   * Deletes every task of an environment, for its purge. Deleting none is fine, so it can
   * run again for the same environment.
   */
  deleteByEnvironment(environmentId: string): void {
    trackDb("tasks.delete_by_environment", () => {
      this.db.prepare(`DELETE FROM tasks WHERE environment_id = ?`).run(environmentId)
    })
  }
}
