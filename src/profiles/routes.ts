import { notFound } from "../errors.js"
import { requireUserHook } from "../middleware/identity.js"
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
  app.register(async (scope) => {
    scope.addHook("preHandler", requireUserHook)

    scope.get(
      "/api/profiles/me",
      {
        schema: {
          tags: ["Profiles"],
          response: { 200: profileSchema }
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
          body: profileUpdateSchema,
          response: { 200: profileSchema }
        }
      },
      async (req) => {
        const { display_name, bio } = req.body
        const userId = req.userId!
        const ts = now()
        const existing = store.findByUserId(userId)
        if (existing) {
          const updated: Profile = {
            ...existing,
            display_name,
            bio: bio ?? existing.bio,
            updated_at: ts
          }
          store.update(updated)
          return updated
        }
        const created: Profile = {
          user_id: userId,
          display_name,
          bio: bio ?? "",
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
          params: profileParamsSchema,
          response: { 200: profileSchema }
        }
      },
      async (req) => {
        const { user_id } = req.params
        const profile = store.findByUserId(user_id)
        if (!profile) throw notFound("profile", user_id)
        return profile
      }
    )
  })
}