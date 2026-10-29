import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import type { FastifyRequest } from "fastify"
import { monotonicFactory } from "ulid"
import type { AccessClient } from "../access.js"
import * as audit from "../audit.js"
import {
  charLength,
  isLowercaseUlid,
  optionalString,
  readBody,
  trimSpace,
  type Fields
} from "../body.js"
import { now } from "../clock.js"
import { fieldError, invalidRequest, notFound, serviceUnavailable } from "../errors.js"
import { headerOf, requestIdOf, traceContextOf } from "../middleware/observability.js"
import { listQuerySchema, parsePage } from "../pagination.js"
import {
  environmentParamsSchema,
  errorSchema,
  taskCreateSchema,
  taskListSchema,
  taskParamsSchema,
  taskSchema,
  taskUpdateSchema,
  type Task
} from "../schemas/common.js"
import type { App } from "../types.js"
import type { TasksStore } from "./store.js"

/**
 * The caller's member id in the environment's tree, from the front door. A create records
 * it as the task's author, and answers 400 without it.
 */
export const MEMBER_HEADER = "x-plat5-member-id"

/**
 * The environment's project id, from the front door. A write that sets an assignee checks
 * them on it, and answers 400 without it.
 */
export const PROJECT_HEADER = "x-plat5-project-id"

/** A header the API requires of the front door: a 400 without it. */
const requiredHeader = (req: FastifyRequest, name: string): string => {
  const value = headerOf(req, name)
  if (value === "") throw invalidRequest()
  return value
}

/** A title's longest, in characters (Unicode code points), after trimming. */
const MAX_TITLE = 255

const STATUSES: readonly string[] = ["todo", "in_progress", "done"]

/** The body's fields: a key that isn't one of these, exactly, is a 422. */
const FIELDS = ["title", "status", "assignee_id"] as const

/** A title, trimmed: required, and at most MAX_TITLE characters. */
const parseTitle = (raw: string): string => {
  const title = trimSpace(raw)
  if (title === "") throw fieldError("title", "Title is required.")
  if (charLength(title) > MAX_TITLE) throw fieldError("title", "Title is too long.")
  return title
}

const checkStatus = (status: string): void => {
  if (!STATUSES.includes(status)) {
    throw fieldError("status", "Status must be todo, in progress, or done.")
  }
}

/**
 * The body's assignee_id: absent (undefined), null, or a member id. Anything else is a 422
 * at assignee_id.
 */
const parseAssignee = (fields: Fields): string | null | undefined => {
  const value = fields.assignee_id
  if (value === undefined || value === null) return value
  if (typeof value !== "string" || !isLowercaseUlid(value)) throw fieldError("assignee_id")
  return value
}

// Monotonic, so tasks made in the same millisecond still list in the order they were made.
const ulid = monotonicFactory()

// Every route scopes its lookups by the environment id in the path, and checks nothing
// about the caller or the environment: the front door decided who may call, on which
// environment. A write that sets an assignee checks the assignee, in this order: the body,
// the task (on an update), the project header, then identity's answer, before writing.
export const registerTaskRoutes = (
  app: App,
  store: TasksStore,
  access: AccessClient,
  assigneePermission: string
): void => {
  /**
   * Asks identity whether the assignee holds `assigneePermission` on the environment's
   * project. The caller may assign, but the assignee isn't the caller, so the front door
   * decided nothing about them
   * (plat5 docs/guides/write-a-service.md#checking-access-outside-a-request). No answer is
   * no: a 503, so nothing is written.
   */
  const checkAssignee = async (req: FastifyRequest, assigneeId: string): Promise<void> => {
    const projectId = requiredHeader(req, PROJECT_HEADER)
    const allowed = await access
      .evaluate(traceContextOf(req), requestIdOf(req) ?? "", {
        memberId: assigneeId,
        kind: "project",
        nodeId: projectId,
        permission: assigneePermission
      })
      .catch(() => {
        throw serviceUnavailable()
      })
    if (!allowed) throw fieldError("assignee_id", "That person can't see this project.")
  }

  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    // An environment is a Plat5 node: its id is in the path, from the front door.
    const base = "/environments/:environment_id/tasks"

    scope.get(
      base,
      {
        schema: {
          tags: ["Tasks"],
          params: environmentParamsSchema,
          querystring: listQuerySchema,
          response: {
            200: taskListSchema
          }
        }
      },
      async (req) => {
        const { environment_id } = req.params
        const page = parsePage(req.query)
        const { items, hasMore } = store.listByEnvironment(environment_id, page)
        return { tasks: items, has_more: hasMore }
      }
    )

    scope.post(
      base,
      {
        schema: {
          tags: ["Tasks"],
          params: environmentParamsSchema,
          body: taskCreateSchema,
          response: {
            201: taskSchema,
            400: errorSchema(
              "No X-Plat5-Member-Id, or an assignee and no X-Plat5-Project-Id."
            ),
            422: errorSchema("A field isn't right, or the assignee can't see the project."),
            503: errorSchema("Identity gave no answer about the assignee. Nothing written.")
          }
        }
      },
      async (req, reply) => {
        const { environment_id } = req.params
        // The author before the body: a create without one is a 400, whatever it sends.
        const memberId = requiredHeader(req, MEMBER_HEADER)
        const fields = readBody(req, FIELDS)
        const rawTitle = optionalString(fields, "title") ?? ""
        const rawStatus = optionalString(fields, "status")
        const title = parseTitle(rawTitle)
        let status = "todo"
        if (rawStatus !== undefined) {
          checkStatus(rawStatus)
          status = rawStatus
        }
        const assigneeId = parseAssignee(fields) ?? null
        if (assigneeId !== null) await checkAssignee(req, assigneeId)
        const ts = now()
        const task: Task = {
          id: ulid().toLowerCase(),
          environment_id,
          title,
          status: status as Task["status"],
          assignee_id: assigneeId,
          created_by: memberId,
          created_at: ts,
          updated_at: ts
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

    scope.get(
      `${base}/:task_id`,
      {
        schema: {
          tags: ["Tasks"],
          params: taskParamsSchema,
          response: { 200: taskSchema }
        }
      },
      async (req) => {
        const { environment_id, task_id } = req.params
        const task = store.findInEnvironment(environment_id, task_id)
        if (!task) throw notFound("task", task_id)
        return task
      }
    )

    scope.patch(
      `${base}/:task_id`,
      {
        schema: {
          tags: ["Tasks"],
          params: taskParamsSchema,
          body: taskUpdateSchema,
          response: {
            200: taskSchema,
            400: errorSchema("An assignee and no X-Plat5-Project-Id."),
            404: errorSchema("No such task in the environment."),
            422: errorSchema("A field isn't right, or the assignee can't see the project."),
            503: errorSchema("Identity gave no answer about the assignee. Nothing written.")
          }
        }
      },
      async (req, reply) => {
        const { environment_id, task_id } = req.params
        const fields = readBody(req, FIELDS)
        const rawTitle = optionalString(fields, "title")
        const status = optionalString(fields, "status")
        const title = rawTitle === undefined ? undefined : parseTitle(rawTitle)
        if (status !== undefined) checkStatus(status)
        // Absent leaves the assignee as it is, and null unassigns: nothing to check.
        const assigneeId = parseAssignee(fields)
        const existing = store.findInEnvironment(environment_id, task_id)
        if (!existing) throw notFound("task", task_id)
        if (typeof assigneeId === "string") await checkAssignee(req, assigneeId)
        const updated: Task = {
          ...existing,
          title: title ?? existing.title,
          status: (status ?? existing.status) as Task["status"],
          assignee_id: assigneeId === undefined ? existing.assignee_id : assigneeId,
          updated_at: now()
        }
        // Deleted since the read: the same 404 the read would answer now.
        if (!store.update(updated)) throw notFound("task", task_id)
        const changes: audit.Details = {}
        audit.changed(changes, "title", existing.title, updated.title)
        audit.changed(changes, "status", existing.status, updated.status)
        audit.changed(changes, "assignee_id", existing.assignee_id, updated.assignee_id)
        audit.setDetails(reply, changes)
        return updated
      }
    )

    scope.delete(
      `${base}/:task_id`,
      {
        schema: {
          tags: ["Tasks"],
          params: taskParamsSchema
        }
      },
      async (req, reply) => {
        const { environment_id, task_id } = req.params
        const existing = store.findInEnvironment(environment_id, task_id)
        if (!existing) throw notFound("task", task_id)
        // Deleted since the read: the same 404 the read would answer now.
        if (!store.delete(environment_id, task_id)) throw notFound("task", task_id)
        // The body is never read. No audit details: the route and the task id in its path say what happened.
        return reply.status(204).send()
      }
    )
  }
  app.register(plugin)
}
