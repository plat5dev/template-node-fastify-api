import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import * as audit from "../audit.js"
import {
  profileParamsSchema,
  profileSchema,
  profileUpdateSchema,
  type Profile
} from "../schemas/common.js"
import type { App } from "../types.js"
import type { ProfilesStore } from "./store.js"

const now = () => new Date().toISOString()

export const registerProfileRoutes = (app: App, store: ProfilesStore): void => {
  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    scope.get(
      "/users/:user_id/profile",
      {
        schema: {
          tags: ["Profiles"],
          params: profileParamsSchema,
          response: { 200: profileSchema }
        }
      },
      async (req) => {
        const { user_id } = req.params
        const existing = store.findByUserId(user_id)
        if (existing) return existing
        const ts = now()
        const created: Profile = {
          user_id,
          bio: "",
          created_at: ts,
          updated_at: ts
        }
        store.insert(created)
        return created
      }
    )

    scope.put(
      "/users/:user_id/profile",
      {
        schema: {
          tags: ["Profiles"],
          params: profileParamsSchema,
          body: profileUpdateSchema,
          response: { 200: profileSchema }
        }
      },
      async (req, reply) => {
        const { bio } = req.body
        const { user_id } = req.params
        const ts = now()
        const existing = store.findByUserId(user_id)
        if (existing) {
          const updated: Profile = {
            ...existing,
            bio,
            updated_at: ts
          }
          store.update(updated)
          const changes: audit.Details = {}
          audit.changed(changes, "bio", existing.bio, updated.bio)
          audit.setDetails(reply, changes)
          return updated
        }
        const created: Profile = {
          user_id,
          bio,
          created_at: ts,
          updated_at: ts
        }
        store.insert(created)
        // A new profile: each field changed from nothing. The profile's id is the user's,
        // which the path already carries, so there is no created id.
        audit.setDetails(reply, { bio: { from: null, to: created.bio } })
        return created
      }
    )
  }
  app.register(plugin)
}
