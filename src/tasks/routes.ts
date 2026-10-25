import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import { ulid } from "ulid"
import * as audit from "../audit.js"
import { invalidRequest, notFound } from "../errors.js"
import { listQuerySchema, parsePage } from "../pagination.js"
import {
  projectParamsSchema,
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
 * The caller's member id in the project's tree, from the front door. A create records it
 * as the task's author, and answers 400 without it.
 */
export const MEMBER_HEADER = "x-plat5-member-id"

const now = () => new Date().toISOString()

// Every route scopes its lookups by the project id in the path, and checks nothing about
// the caller or the project: the front door decided who may call, on which project.
export const registerTaskRoutes = (app: App, store: TasksStore): void => {
  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    // A project is a Plat5 node: its id is in the path, from the front door.
    const base = "/projects/:project_id/tasks"

    scope.get(
      base,
      {
        schema: {
          tags: ["Tasks"],
          params: projectParamsSchema,
          querystring: listQuerySchema,
          response: {
            200: taskListSchema
          }
        }
      },
      async (req) => {
        const { project_id } = req.params
        const page = parsePage(req.query)
        const { items, hasMore } = store.listByProject(project_id, page)
        return { tasks: items, has_more: hasMore }
      }
    )

    scope.post(
      base,
      {
        schema: {
          tags: ["Tasks"],
          params: projectParamsSchema,
          body: taskCreateSchema,
          response: { 201: taskSchema }
        }
      },
      async (req, reply) => {
        const { project_id } = req.params
        const memberId = req.headers[MEMBER_HEADER]
        if (typeof memberId !== "string" || memberId === "") throw invalidRequest()
        const { title, status } = req.body
        const ts = now()
        const task: Task = {
          id: ulid().toLowerCase(),
          project_id,
          title,
          status: status ?? "todo",
          created_by: memberId,
          created_at: ts,
          updated_at: ts
        }
        store.insert(task)
        audit.setDetails(reply, {
          task_id: task.id,
          title: task.title,
          status: task.status
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
        const { project_id, task_id } = req.params
        const task = store.findInProject(project_id, task_id)
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
          response: { 200: taskSchema }
        }
      },
      async (req, reply) => {
        const { project_id, task_id } = req.params
        const { title, status } = req.body
        const existing = store.findInProject(project_id, task_id)
        if (!existing) throw notFound("task", task_id)
        const updated: Task = {
          ...existing,
          title: title ?? existing.title,
          status: status ?? existing.status,
          updated_at: now()
        }
        store.update(updated)
        const changes: audit.Details = {}
        audit.changed(changes, "title", existing.title, updated.title)
        audit.changed(changes, "status", existing.status, updated.status)
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
        const { project_id, task_id } = req.params
        const existing = store.findInProject(project_id, task_id)
        if (!existing) throw notFound("task", task_id)
        store.delete(project_id, task_id)
        // No audit details: the route and the task id in its path say what happened.
        return reply.status(204).send()
      }
    )
  }
  app.register(plugin)
}
