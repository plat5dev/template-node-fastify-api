import type { FastifyInstance } from "fastify"
import { ulid } from "ulid"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import { notFound } from "../errors.js"
import { requireOrgHook } from "../middleware/identity.js"
import {
  projectCreateSchema,
  projectSchema,
  projectUpdateSchema,
  type Project
} from "../schemas/common.js"
import type { ProjectsStore } from "./store.js"

const now = () => new Date().toISOString()

const jsonSchema = (schema: z.ZodTypeAny) =>
  zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" })

export const registerProjectRoutes = (
  app: FastifyInstance,
  store: ProjectsStore
): void => {
  app.register(async (scope) => {
    scope.addHook("preHandler", requireOrgHook)

    const base = "/api/organizations/:organization_id/projects"

    scope.get(
      base,
      {
        schema: {
          tags: ["Projects"],
          params: jsonSchema(z.object({ organization_id: z.string() })),
          response: {
            200: jsonSchema(z.object({ projects: z.array(projectSchema) }))
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
          params: jsonSchema(z.object({ organization_id: z.string() })),
          body: jsonSchema(projectCreateSchema),
          response: { 201: jsonSchema(projectSchema) }
        }
      },
      async (req, reply) => {
        const body = projectCreateSchema.parse(req.body)
        const ts = now()
        const project: Project = {
          id: ulid(),
          organization_id: req.organizationId!,
          name: body.name,
          description: body.description ?? "",
          created_by_membership_id: req.membershipId!,
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
          params: jsonSchema(
            z.object({ organization_id: z.string(), project_id: z.string() })
          ),
          response: { 200: jsonSchema(projectSchema) }
        }
      },
      async (req) => {
        const { project_id } = req.params as { project_id: string }
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
          params: jsonSchema(
            z.object({ organization_id: z.string(), project_id: z.string() })
          ),
          body: jsonSchema(projectUpdateSchema),
          response: { 200: jsonSchema(projectSchema) }
        }
      },
      async (req) => {
        const { project_id } = req.params as { project_id: string }
        const body = projectUpdateSchema.parse(req.body)
        const existing = store.findInOrg(req.organizationId!, project_id)
        if (!existing) throw notFound("project", project_id)
        const updated: Project = {
          ...existing,
          name: body.name ?? existing.name,
          description: body.description ?? existing.description,
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
          params: jsonSchema(
            z.object({ organization_id: z.string(), project_id: z.string() })
          )
        }
      },
      async (req, reply) => {
        const { project_id } = req.params as { project_id: string }
        const existing = store.findInOrg(req.organizationId!, project_id)
        if (!existing) throw notFound("project", project_id)
        store.delete(req.organizationId!, project_id)
        return reply.status(204).send()
      }
    )
  })
}
