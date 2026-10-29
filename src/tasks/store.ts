import type { Db } from "../db.js"
import { trackDb } from "../db.js"
import { trim, type Page } from "../pagination.js"
import type { Task } from "../schemas/common.js"

const COLUMNS =
  "id, environment_id, title, status, assignee_id, created_by, created_at, updated_at"

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
        .prepare(`INSERT INTO tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          t.id,
          t.environment_id,
          t.title,
          t.status,
          t.assignee_id,
          t.created_by,
          t.created_at,
          t.updated_at
        )
    })
  }

  /**
   * Writes `t`'s fields to the task with its id in its environment, and says whether there
   * was one: false when it's gone, such as deleted since it was read.
   */
  update(t: Task): boolean {
    return trackDb("tasks.update", () => {
      const { changes } = this.db
        .prepare(
          `UPDATE tasks SET title = ?, status = ?, assignee_id = ?, updated_at = ?
           WHERE id = ? AND environment_id = ?`
        )
        .run(t.title, t.status, t.assignee_id, t.updated_at, t.id, t.environment_id)
      return changes > 0
    })
  }

  /** Deletes the task with `taskId` in the environment, and says whether there was one. */
  delete(environmentId: string, taskId: string): boolean {
    return trackDb("tasks.delete", () => {
      const { changes } = this.db
        .prepare(`DELETE FROM tasks WHERE id = ? AND environment_id = ?`)
        .run(taskId, environmentId)
      return changes > 0
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
