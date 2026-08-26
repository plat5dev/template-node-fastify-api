import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import { ulid } from "ulid"
import { notFound } from "../errors.js"
import { requireOrgHook } from "../middleware/identity.js"
import {
  organizationParamsSchema,
  projectCreateSchema,
  projectListSchema,
  projectParamsSchema,
  projectSchema,
  projectUpdateSchema,
  type Project
} from "../schemas/common.js"
import type { App } from "../types.js"
import type { ProjectsStore } from "./store.js"

const now = () => new Date().toISOString()

export const registerProjectRoutes = (app: App, store: ProjectsStore): void => {
  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    scope.addHook("preHandler", requireOrgHook)

    const base = "/api/organizations/:organization_id/projects"

    scope.get(
      base,
      {
        schema: {
          tags: ["Projects"],
          params: organizationParamsSchema,
          response: {
            200: projectListSchema
          }
        }
      },
      async (req) => {
        const projects = store.listByOrg(req.organizationId!)
        return { projects }
      }
    )

    scope.post(
      base,
      {
        schema: {
          tags: ["Projects"],
          params: organizationParamsSchema,
          body: projectCreateSchema,
          response: { 201: projectSchema }
        }
      },
      async (req, reply) => {
        const { name, description } = req.body
        const ts = now()
        const project: Project = {
          id: ulid(),
          organization_id: req.organizationId!,
          name,
          description: description ?? "",
          created_by_member_id: req.memberId!,
          created_at: ts,
          updated_at: ts
        }
        store.insert(project)
        return reply.status(201).send(project)
      }
    )

    scope.get(
      `${base}/:project_id`,
      {
        schema: {
          tags: ["Projects"],
          params: projectParamsSchema,
          response: { 200: projectSchema }
        }
      },
      async (req) => {
        const { project_id } = req.params
        const project = store.findInOrg(req.organizationId!, project_id)
        if (!project) throw notFound("project", project_id)
        return project
      }
    )

    scope.patch(
      `${base}/:project_id`,
      {
        schema: {
          tags: ["Projects"],
          params: projectParamsSchema,
          body: projectUpdateSchema,
          response: { 200: projectSchema }
        }
      },
      async (req) => {
        const { project_id } = req.params
        const { name, description } = req.body
        const existing = store.findInOrg(req.organizationId!, project_id)
        if (!existing) throw notFound("project", project_id)
        const updated: Project = {
          ...existing,
          name: name ?? existing.name,
          description: description ?? existing.description,
          updated_at: now()
        }
        store.update(updated)
        return updated
      }
    )

    scope.delete(
      `${base}/:project_id`,
      {
        schema: {
          tags: ["Projects"],
          params: projectParamsSchema
        }
      },
      async (req, reply) => {
        const { project_id } = req.params
        const existing = store.findInOrg(req.organizationId!, project_id)
        if (!existing) throw notFound("project", project_id)
        store.delete(req.organizationId!, project_id)
        return reply.status(204).send()
      }
    )
  }
  app.register(plugin)
}
