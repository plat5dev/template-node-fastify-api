import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import { notFound } from "../errors.js"
import { requireUserHook } from "../middleware/identity.js"
import {
  profileSchema,
  profileUpdateSchema,
  type Profile
} from "../schemas/common.js"
import type { ProfilesStore } from "./store.js"

const now = () => new Date().toISOString()

const jsonSchema = (schema: z.ZodTypeAny) =>
  zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" })

export const registerProfileRoutes = (
  app: FastifyInstance,
  store: ProfilesStore
): void => {
  app.register(async (scope) => {
    scope.addHook("preHandler", requireUserHook)

    scope.get(
      "/api/profiles/me",
      {
        schema: {
          tags: ["Profiles"],
          response: { 200: jsonSchema(profileSchema) }
        }
      },
      async (req) => {
        const userId = req.userId!
        const existing = store.findByUserId(userId)
        if (existing) return existing
        const ts = now()
        const created: Profile = {
          user_id: userId,
          display_name: "Anonymous",
          bio: "",
          created_at: ts,
          updated_at: ts
        }
        store.insert(created)
        return created
      }
    )

    scope.put(
      "/api/profiles/me",
      {
        schema: {
          tags: ["Profiles"],
          body: jsonSchema(profileUpdateSchema),
          response: { 200: jsonSchema(profileSchema) }
        }
      },
      async (req) => {
        const userId = req.userId!
        const body = profileUpdateSchema.parse(req.body)
        const ts = now()
        const existing = store.findByUserId(userId)
        if (existing) {
          const updated: Profile = {
            ...existing,
            display_name: body.display_name,
            bio: body.bio ?? existing.bio,
            updated_at: ts
          }
          store.update(updated)
          return updated
        }
        const created: Profile = {
          user_id: userId,
          display_name: body.display_name,
          bio: body.bio ?? "",
          created_at: ts,
          updated_at: ts
        }
        store.insert(created)
        return created
      }
    )

    scope.get(
      "/api/profiles/:user_id",
      {
        schema: {
          tags: ["Profiles"],
          params: jsonSchema(z.object({ user_id: z.string() })),
          response: { 200: jsonSchema(profileSchema) }
        }
      },
      async (req) => {
        const { user_id } = req.params as { user_id: string }
        const profile = store.findByUserId(user_id)
        if (!profile) throw notFound("profile", user_id)
        return profile
      }
    )
  })
}
