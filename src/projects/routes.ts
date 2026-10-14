import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import { ulid } from "ulid"
import * as audit from "../audit.js"
import { notFound } from "../errors.js"
import { listQuerySchema, parsePage } from "../pagination.js"
import {
  orgParamsSchema,
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
    const base = "/organizations/:organization_id/projects"

    scope.get(
      base,
      {
        schema: {
          tags: ["Projects"],
          params: orgParamsSchema,
          querystring: listQuerySchema,
          response: {
            200: projectListSchema
          }
        }
      },
      async (req) => {
        const { organization_id } = req.params
        const page = parsePage(req.query)
        const { items, hasMore } = store.listByOrg(organization_id, page)
        return { projects: items, has_more: hasMore }
      }
    )

    scope.post(
      base,
      {
        schema: {
          tags: ["Projects"],
          params: orgParamsSchema,
          body: projectCreateSchema,
          response: { 201: projectSchema }
        }
      },
      async (req, reply) => {
        const { name, description } = req.body
        const { organization_id } = req.params
        const ts = now()
        const project: Project = {
          id: ulid(),
          organization_id,
          name,
          description: description ?? "",
          created_at: ts,
          updated_at: ts
        }
        store.insert(project)
        audit.setDetails(reply, { project_id: project.id, name: project.name })
        audit.setCreated(reply, project.id)
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
        const { organization_id, project_id } = req.params
        const project = store.findInOrg(organization_id, project_id)
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
      async (req, reply) => {
        const { organization_id, project_id } = req.params
        const { name, description } = req.body
        const existing = store.findInOrg(organization_id, project_id)
        if (!existing) throw notFound("project", project_id)
        const updated: Project = {
          ...existing,
          name: name ?? existing.name,
          description: description ?? existing.description,
          updated_at: now()
        }
        store.update(updated)
        const changes: audit.Details = {}
        audit.changed(changes, "name", existing.name, updated.name)
        audit.changed(changes, "description", existing.description, updated.description)
        audit.setDetails(reply, changes)
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
        const { organization_id, project_id } = req.params
        const existing = store.findInOrg(organization_id, project_id)
        if (!existing) throw notFound("project", project_id)
        store.delete(organization_id, project_id)
        // No audit details: the route and the project id in its path say what happened.
        return reply.status(204).send()
      }
    )
  }
  app.register(plugin)
}
