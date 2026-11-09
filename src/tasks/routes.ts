import type { FastifyPluginAsyncTypebox, TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import type { FastifyRequest } from "fastify"
import { monotonicFactory } from "ulid"
import type { AccessClient } from "../access.ts"
import * as audit from "../audit.ts"
import { fieldError, invalidRequest, notFound, serviceUnavailable } from "../errors.ts"
import { headerOf, requestIdOf, traceContextOf } from "../observability.ts"
import { listQuerySchema, pageOf } from "../pagination.ts"
import {
  errorSchema,
  projectParamsSchema,
  type Task,
  taskCreateSchema,
  taskListSchema,
  taskMessages,
  taskParamsSchema,
  taskSchema,
  taskUpdateSchema
} from "../schemas.ts"
import type { TasksStore } from "./store.ts"

/**
 * The caller's member id in the project's tree, from the front door. A create records it as
 * the task's author, and answers 400 without it.
 */
export const MEMBER_HEADER = "x-plat5-member-id"

export type TaskRoutesOptions = {
  store: TasksStore
  access: AccessClient
  /** The permission a task's assignee needs on its project. */
  assigneePermission: string
}

// Monotonic, so tasks made in the same millisecond still list in the order they were made.
const ulid = monotonicFactory()

/** A create without the author is a 400, before its body is read. */
const requireMember = async (req: FastifyRequest) => {
  if (headerOf(req, MEMBER_HEADER) === undefined) throw invalidRequest()
}

/** A title is trimmed of white space before it's checked. */
const trimTitle = async (req: FastifyRequest) => {
  const body = req.body as { title?: unknown } | null
  if (typeof body?.title === "string") body.title = body.title.trim()
}

/**
 * Tasks inside a project, a Plat5 node whose id is in the path, from the front door. Every
 * lookup is scoped by it, and nothing is checked about the caller or the project: the front
 * door decided who may call, on which project. A write that sets an assignee checks the
 * assignee, in this order: the body, the task (on an update), then identity's answer.
 */
export const taskRoutes: FastifyPluginAsyncTypebox<TaskRoutesOptions> = async (
  app,
  { store, access, assigneePermission }
) => {
  /**
   * Asks identity whether the assignee holds `assigneePermission` on the project. The caller
   * may assign, but the assignee isn't the caller, so the front door decided nothing about
   * them (plat5 docs/guides/write-a-service.md#checking-access-outside-a-request). No
   * answer is no: a 503, so nothing is written.
   */
  const checkAssignee = async (req: FastifyRequest, projectId: string, assigneeId: string) => {
    const allowed = await access
      .evaluate(traceContextOf(req), requestIdOf(req), {
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

  const base = "/projects/:project_id/tasks"
  const tags = ["Tasks"]
  const config = { messages: taskMessages }
  const invalid = errorSchema("A field isn't right, or the assignee can't see the project.")
  const unavailable = errorSchema("Identity gave no answer about the assignee. Nothing written.")

  app.get(
    base,
    {
      schema: {
        tags,
        params: projectParamsSchema,
        querystring: listQuerySchema,
        response: { 200: taskListSchema, 422: errorSchema("A list parameter isn't right.") }
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
          400: errorSchema("No X-Plat5-Member-Id, or a body not sent as JSON."),
          422: invalid,
          503: unavailable
        }
      },
      config,
      onRequest: requireMember,
      preValidation: trimTitle
    },
    async (req, reply) => {
      const { project_id } = req.params
      const { title, status = "todo", assignee_id = null } = req.body
      if (assignee_id !== null) await checkAssignee(req, project_id, assignee_id)
      const now = new Date().toISOString()
      const task: Task = {
        id: ulid().toLowerCase(),
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
        response: { 200: taskSchema, 404: errorSchema("No such task in the project.") }
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
          400: errorSchema("A body not sent as JSON."),
          404: errorSchema("No such task in the project."),
          422: invalid,
          503: unavailable
        }
      },
      config,
      preValidation: trimTitle
    },
    async (req, reply) => {
      const { project_id, task_id } = req.params
      const { title, status, assignee_id } = req.body
      const existing = store.find(project_id, task_id)
      if (!existing) throw notFound("task", task_id)
      // Absent leaves the assignee as it is, and null unassigns: nothing to check.
      if (typeof assignee_id === "string") await checkAssignee(req, project_id, assignee_id)
      const updated: Task = {
        ...existing,
        title: title ?? existing.title,
        status: status ?? existing.status,
        assignee_id: assignee_id === undefined ? existing.assignee_id : assignee_id,
        updated_at: new Date().toISOString()
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

  // A delete reads no body: in a scope of its own, whatever is sent is ignored.
  await app.register(async (plain) => {
    const scope = plain.withTypeProvider<TypeBoxTypeProvider>()
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser("*", (_req, payload, done) => {
      payload.resume()
      payload.on("end", () => done(null))
    })
    scope.delete(
      `${base}/:task_id`,
      {
        schema: {
          tags,
          params: taskParamsSchema,
          response: {
            204: { type: "null", description: "Deleted." },
            404: errorSchema("No such task in the project.")
          }
        }
      },
      async (req, reply) => {
        const { project_id, task_id } = req.params
        // No audit details: the route and the task id in its path say what happened.
        if (!store.delete(project_id, task_id)) throw notFound("task", task_id)
        return reply.status(204).send(null)
      }
    )
  })
}
