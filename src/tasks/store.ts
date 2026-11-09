import { type Db, trackDb } from "../db.ts"
import { type Page, trim } from "../pagination.ts"
import type { Task } from "../schemas.ts"

const COLUMNS = "id, project_id, title, status, assignee_id, created_by, created_at, updated_at"

/** A project's tasks. Every statement is scoped by the project's id. */
export const tasksStore = (db: Db) => {
  const list = db.prepare(
    `SELECT ${COLUMNS} FROM tasks WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`
  )
  const find = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE project_id = ? AND id = ?`)
  const insert = db.prepare(`INSERT INTO tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  const update = db.prepare(
    `UPDATE tasks SET title = ?, status = ?, assignee_id = ?, updated_at = ? WHERE project_id = ? AND id = ?`
  )
  const remove = db.prepare(`DELETE FROM tasks WHERE project_id = ? AND id = ?`)
  const removeAll = db.prepare(`DELETE FROM tasks WHERE project_id = ?`)

  return {
    /** One page of the project's tasks in id order, and whether there are more. */
    list: (projectId: string, page: Page): { items: Task[]; hasMore: boolean } =>
      trackDb("tasks.list", () =>
        trim(list.all(projectId, page.startingAfter, page.limit + 1) as Task[], page)
      ),

    find: (projectId: string, taskId: string): Task | undefined =>
      trackDb("tasks.find", () => find.get(projectId, taskId) as Task | undefined),

    insert: (t: Task): void => {
      trackDb("tasks.insert", () =>
        insert.run(
          t.id,
          t.project_id,
          t.title,
          t.status,
          t.assignee_id,
          t.created_by,
          t.created_at,
          t.updated_at
        )
      )
    },

    /** Writes `t`'s fields to its task, and says whether there was one: false when it's gone, deleted since it was read. */
    update: (t: Task): boolean =>
      trackDb(
        "tasks.update",
        () =>
          update.run(t.title, t.status, t.assignee_id, t.updated_at, t.project_id, t.id).changes > 0
      ),

    /** Deletes the task, and says whether there was one. */
    delete: (projectId: string, taskId: string): boolean =>
      trackDb("tasks.delete", () => remove.run(projectId, taskId).changes > 0),

    /** Deletes every task of a project, for its purge. Deleting none is fine, so it can run again. */
    deleteByProject: (projectId: string): void => {
      trackDb("tasks.delete_by_project", () => removeAll.run(projectId))
    }
  }
}

export type TasksStore = ReturnType<typeof tasksStore>
