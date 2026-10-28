import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import type { FastifyRequest } from "fastify"
import { monotonicFactory } from "ulid"
import type { AccessClient } from "../access.js"
import * as audit from "../audit.js"
import { fieldError, invalidRequest, notFound, serviceUnavailable } from "../errors.js"
import { requestIdOf, traceContextOf } from "../middleware/observability.js"
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
  const value = req.headers[name]
  if (typeof value !== "string" || value === "") throw invalidRequest()
  return value
}

const now = () => new Date().toISOString()

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
        },
        // The author before the body: a create without one is a 400, whatever it sends.
        onRequest: async (req) => {
          requiredHeader(req, MEMBER_HEADER)
        }
      },
      async (req, reply) => {
        const { environment_id } = req.params
        const memberId = requiredHeader(req, MEMBER_HEADER)
        const { title, status, assignee_id = null } = req.body
        if (assignee_id !== null) await checkAssignee(req, assignee_id)
        const ts = now()
        const task: Task = {
          id: ulid().toLowerCase(),
          environment_id,
          title,
          status: status ?? "todo",
          assignee_id,
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
        const { title, status, assignee_id } = req.body
        const existing = store.findInEnvironment(environment_id, task_id)
        if (!existing) throw notFound("task", task_id)
        // Absent leaves the assignee as it is, and null unassigns: nothing to check.
        if (typeof assignee_id === "string") await checkAssignee(req, assignee_id)
        const updated: Task = {
          ...existing,
          title: title ?? existing.title,
          status: status ?? existing.status,
          assignee_id: assignee_id === undefined ? existing.assignee_id : assignee_id,
          updated_at: now()
        }
        store.update(updated)
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
        store.delete(environment_id, task_id)
        // No audit details: the route and the task id in its path say what happened.
        return reply.status(204).send()
      }
    )
  }
  app.register(plugin)
}
