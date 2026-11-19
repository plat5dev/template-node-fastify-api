import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import type { FastifyRequest } from "fastify"
import { monotonicFactory } from "ulid"
import type { AccessClient } from "./access.ts"
import * as audit from "./audit.ts"
import type { Db } from "./db.ts"
import { fieldError, invalidRequest, notFound, serviceUnavailable } from "./errors.ts"
import {
  errorSchema,
  listQuerySchema,
  type Page,
  pageOf,
  projectParamsSchema,
  type Task,
  taskCreateSchema,
  taskListSchema,
  taskParamsSchema,
  taskSchema,
  taskUpdateSchema,
  trimPage
} from "./schemas.ts"
import { headerOf } from "./telemetry.ts"

export const MEMBER_HEADER = "x-plat5-member-id"

const COLUMNS = "id, project_id, title, status, assignee_id, created_by, created_at, updated_at"

export const tasksStore = (db: Db) => {
  const listStmt = db.prepare(
    `SELECT ${COLUMNS} FROM tasks WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`
  )
  const findStmt = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE project_id = ? AND id = ?`)
  const insertStmt = db.prepare(`INSERT INTO tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  const updateStmt = db.prepare(
    `UPDATE tasks SET title = ?, status = ?, assignee_id = ?, updated_at = ? WHERE project_id = ? AND id = ?`
  )
  const deleteStmt = db.prepare(`DELETE FROM tasks WHERE project_id = ? AND id = ?`)
  const deleteByProjectStmt = db.prepare(`DELETE FROM tasks WHERE project_id = ?`)

  return {
    list: (projectId: string, page: Page): { items: Task[]; hasMore: boolean } =>
      trimPage(listStmt.all(projectId, page.startingAfter, page.limit + 1) as Task[], page),

    find: (projectId: string, taskId: string): Task | undefined =>
      findStmt.get(projectId, taskId) as Task | undefined,

    insert: (t: Task): void => {
      insertStmt.run(
        t.id,
        t.project_id,
        t.title,
        t.status,
        t.assignee_id,
        t.created_by,
        t.created_at,
        t.updated_at
      )
    },

    update: (t: Task): boolean =>
      updateStmt.run(t.title, t.status, t.assignee_id, t.updated_at, t.project_id, t.id).changes > 0,

    delete: (projectId: string, taskId: string): boolean =>
      deleteStmt.run(projectId, taskId).changes > 0,

    deleteByProject: (projectId: string): void => {
      deleteByProjectStmt.run(projectId)
    }
  }
}

export type TasksStore = ReturnType<typeof tasksStore>

export type TaskRoutesOptions = {
  store: TasksStore
  access: AccessClient
  assigneePermission: string
}

// Monotonic ULIDs preserve creation order within the same millisecond.
const nextId = monotonicFactory()

const normalizeTitle = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw fieldError("title", "Title must not be blank.")
  if ([...trimmed].length > 255) throw fieldError("title", "Title must be at most 255 characters.")
  return trimmed
}

const requireMember = async (req: FastifyRequest) => {
  if (headerOf(req, MEMBER_HEADER) === undefined) throw invalidRequest()
}

export const taskRoutes: FastifyPluginAsyncTypebox<TaskRoutesOptions> = async (
  app,
  { store, access, assigneePermission }
) => {
  const checkAssignee = async (req: FastifyRequest, projectId: string, assigneeId: string) => {
    const allowed = await access
      .evaluate(
        {
          memberId: assigneeId,
          kind: "project",
          nodeId: projectId,
          permission: assigneePermission
        },
        { requestId: req.id || null, log: req.log }
      )
      .catch(() => {
        throw serviceUnavailable()
      })
    if (!allowed) throw fieldError("assignee_id", "That person can't see this project.")
  }

  const base = "/projects/:project_id/tasks"
  const tags = ["Tasks"]
  const invalid = errorSchema("Validation error, or assignee cannot access the project.")
  const unavailable = errorSchema("Identity access evaluation unavailable.")

  app.get(
    base,
    {
      schema: {
        tags,
        params: projectParamsSchema,
        querystring: listQuerySchema,
        response: { 200: taskListSchema, 422: errorSchema("Invalid pagination parameter.") }
      }
    },
    async (req) => {
      const { items, hasMore } = store.list(req.params.project_id, pageOf(req.query))
      return { tasks: items, has_more: hasMore }
    }
  )

  app.post(
    base,
    {
      schema: {
        tags,
        params: projectParamsSchema,
        body: taskCreateSchema,
        response: {
          201: taskSchema,
          400: errorSchema("Missing X-Plat5-Member-Id or malformed JSON body."),
          422: invalid,
          503: unavailable
        }
      },
      onRequest: requireMember
    },
    async (req, reply) => {
      const { project_id } = req.params
      const title = normalizeTitle(req.body.title)
      const { status = "todo", assignee_id = null } = req.body

      if (assignee_id !== null) await checkAssignee(req, project_id, assignee_id)

      const now = new Date().toISOString()
      const task: Task = {
        id: nextId().toLowerCase(),
        project_id,
        title,
        status,
        assignee_id,
        created_by: headerOf(req, MEMBER_HEADER)!,
        created_at: now,
        updated_at: now
      }
      store.insert(task)

      audit.setDetails(reply, {
        task_id: task.id,
        title: task.title,
        status: task.status,
        assignee_id: task.assignee_id
      })
      audit.setCreated(reply, task.id)
      return reply.status(201).send(task)
    }
  )

  app.get(
    `${base}/:task_id`,
    {
      schema: {
        tags,
        params: taskParamsSchema,
        response: { 200: taskSchema, 404: errorSchema("Task not found in project.") }
      }
    },
    async (req) => {
      const { project_id, task_id } = req.params
      const task = store.find(project_id, task_id)
      if (!task) throw notFound("task", task_id)
      return task
    }
  )

  app.patch(
    `${base}/:task_id`,
    {
      schema: {
        tags,
        params: taskParamsSchema,
        body: taskUpdateSchema,
        response: {
          200: taskSchema,
          400: errorSchema("Malformed JSON body."),
          404: errorSchema("Task not found in project."),
          422: invalid,
          503: unavailable
        }
      }
    },
    async (req, reply) => {
      const { project_id, task_id } = req.params
      const nextTitleInput =
        typeof req.body.title === "string" ? normalizeTitle(req.body.title) : undefined
      const { status, assignee_id } = req.body

      const existing = store.find(project_id, task_id)
      if (!existing) throw notFound("task", task_id)

      if (typeof assignee_id === "string") await checkAssignee(req, project_id, assignee_id)

      const title = nextTitleInput ?? existing.title
      const nextStatus = status ?? existing.status
      const nextAssignee = assignee_id === undefined ? existing.assignee_id : assignee_id

      const changes: audit.AuditDetails = {}
      audit.changed(changes, "title", existing.title, title)
      audit.changed(changes, "status", existing.status, nextStatus)
      audit.changed(changes, "assignee_id", existing.assignee_id, nextAssignee)

      // No-op PATCH: skip DB write and preserve updated_at.
      if (Object.keys(changes).length === 0) return existing

      const updated: Task = {
        ...existing,
        title,
        status: nextStatus,
        assignee_id: nextAssignee,
        updated_at: new Date().toISOString()
      }
      if (!store.update(updated)) throw notFound("task", task_id)

      audit.setDetails(reply, changes)
      return updated
    }
  )

  app.delete(
    `${base}/:task_id`,
    {
      schema: {
        tags,
        params: taskParamsSchema,
        response: {
          204: { type: "null", description: "Deleted." },
          404: errorSchema("Task not found in project.")
        }
      }
    },
    async (req, reply) => {
      const { project_id, task_id } = req.params
      if (!store.delete(project_id, task_id)) throw notFound("task", task_id)
      return reply.status(204).send(null)
    }
  )
}
