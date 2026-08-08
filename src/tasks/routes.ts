import type { FastifyInstance } from "fastify"
import { ulid } from "ulid"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import { notFound } from "../errors.js"
import { requireOrgHook } from "../middleware/identity.js"
import type { ProjectsStore } from "../projects/store.js"
import {
  taskCreateSchema,
  taskSchema,
  taskUpdateSchema,
  type Task
} from "../schemas/common.js"
import type { TasksStore } from "./store.js"

const now = () => new Date().toISOString()

const jsonSchema = (schema: z.ZodTypeAny) =>
  zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" })

export const registerTaskRoutes = (
  app: FastifyInstance,
  store: TasksStore,
  projects: ProjectsStore
): void => {
  app.register(async (scope) => {
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
          params: jsonSchema(
            z.object({ organization_id: z.string(), project_id: z.string() })
          ),
          response: {
            200: jsonSchema(z.object({ tasks: z.array(taskSchema) }))
          }
        }
      },
      async (req) => {
        const { project_id } = req.params as { project_id: string }
        requireProject(req.organizationId!, project_id)
        return { tasks: store.listByProject(req.organizationId!, project_id) }
      }
    )

    scope.post(
      base,
      {
        schema: {
          tags: ["Tasks"],
          params: jsonSchema(
            z.object({ organization_id: z.string(), project_id: z.string() })
          ),
          body: jsonSchema(taskCreateSchema),
          response: { 201: jsonSchema(taskSchema) }
        }
      },
      async (req, reply) => {
        const { project_id } = req.params as { project_id: string }
        requireProject(req.organizationId!, project_id)
        const body = taskCreateSchema.parse(req.body)
        const ts = now()
        const task: Task = {
          id: ulid(),
          organization_id: req.organizationId!,
          project_id,
          title: body.title,
          status: body.status ?? "todo",
          created_by_membership_id: req.membershipId!,
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
          params: jsonSchema(
            z.object({
              organization_id: z.string(),
              project_id: z.string(),
              task_id: z.string()
            })
          ),
          response: { 200: jsonSchema(taskSchema) }
        }
      },
      async (req) => {
        const { project_id, task_id } = req.params as {
          project_id: string
          task_id: string
        }
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
          params: jsonSchema(
            z.object({
              organization_id: z.string(),
              project_id: z.string(),
              task_id: z.string()
            })
          ),
          body: jsonSchema(taskUpdateSchema),
          response: { 200: jsonSchema(taskSchema) }
        }
      },
      async (req) => {
        const { project_id, task_id } = req.params as {
          project_id: string
          task_id: string
        }
        requireProject(req.organizationId!, project_id)
        const body = taskUpdateSchema.parse(req.body)
        const existing = store.findInProject(
          req.organizationId!,
          project_id,
          task_id
        )
        if (!existing) throw notFound("task", task_id)
        const updated: Task = {
          ...existing,
          title: body.title ?? existing.title,
          status: body.status ?? existing.status,
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
          params: jsonSchema(
            z.object({
              organization_id: z.string(),
              project_id: z.string(),
              task_id: z.string()
            })
          )
        }
      },
      async (req, reply) => {
        const { project_id, task_id } = req.params as {
          project_id: string
          task_id: string
        }
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
  })
}
