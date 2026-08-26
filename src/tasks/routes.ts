import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import { ulid } from "ulid"
import { notFound } from "../errors.js"
import { requireOrgHook } from "../middleware/identity.js"
import type { ProjectsStore } from "../projects/store.js"
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

const now = () => new Date().toISOString()

export const registerTaskRoutes = (
  app: App,
  store: TasksStore,
  projects: ProjectsStore
): void => {
  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    scope.addHook("preHandler", requireOrgHook)

    const base =
      "/api/organizations/:organization_id/projects/:project_id/tasks"

    const requireProject = (organizationId: string, projectId: string) => {
      const project = projects.findInOrg(organizationId, projectId)
      if (!project) throw notFound("project", projectId)
    }

    scope.get(
      base,
      {
        schema: {
          tags: ["Tasks"],
          params: projectParamsSchema,
          response: {
            200: taskListSchema
          }
        }
      },
      async (req) => {
        const { project_id } = req.params
        requireProject(req.organizationId!, project_id)
        return { tasks: store.listByProject(req.organizationId!, project_id) }
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
        requireProject(req.organizationId!, project_id)
        const { title, status } = req.body
        const ts = now()
        const task: Task = {
          id: ulid(),
          organization_id: req.organizationId!,
          project_id,
          title,
          status: status ?? "todo",
          created_by_member_id: req.memberId!,
          created_at: ts,
          updated_at: ts
        }
        store.insert(task)
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
        requireProject(req.organizationId!, project_id)
        const task = store.findInProject(
          req.organizationId!,
          project_id,
          task_id
        )
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
      async (req) => {
        const { project_id, task_id } = req.params
        requireProject(req.organizationId!, project_id)
        const { title, status } = req.body
        const existing = store.findInProject(
          req.organizationId!,
          project_id,
          task_id
        )
        if (!existing) throw notFound("task", task_id)
        const updated: Task = {
          ...existing,
          title: title ?? existing.title,
          status: status ?? existing.status,
          updated_at: now()
        }
        store.update(updated)
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
        requireProject(req.organizationId!, project_id)
        const existing = store.findInProject(
          req.organizationId!,
          project_id,
          task_id
        )
        if (!existing) throw notFound("task", task_id)
        store.delete(req.organizationId!, project_id, task_id)
        return reply.status(204).send()
      }
    )
  }
  app.register(plugin)
}
