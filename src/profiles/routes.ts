import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import * as audit from "../audit.ts"
import {
  errorSchema,
  profileMessages,
  profileParamsSchema,
  profileSchema,
  profileUpdateSchema
} from "../schemas.ts"
import type { ProfilesStore } from "./store.ts"

/** The person's own profile, on a user route: the user id in the path, from the front door. */
export const profileRoutes: FastifyPluginAsyncTypebox<{ store: ProfilesStore }> = async (
  app,
  { store }
) => {
  const path = "/users/:user_id/profile"
  const tags = ["Profiles"]

  // On the person's first call, an empty profile.
  app.get(
    path,
    { schema: { tags, params: profileParamsSchema, response: { 200: profileSchema } } },
    async (req) => store.getOrCreate(req.params.user_id, new Date().toISOString())
  )

  app.put(
    path,
    {
      schema: {
        tags,
        params: profileParamsSchema,
        body: profileUpdateSchema,
        response: {
          200: profileSchema,
          400: errorSchema("A body not sent as JSON."),
          422: errorSchema("The bio isn't right.")
        }
      },
      config: { messages: profileMessages }
    },
    async (req, reply) => {
      // Not trimmed, and "" is a bio.
      const { before, after } = store.upsert(
        req.params.user_id,
        req.body.bio,
        new Date().toISOString()
      )
      // A new profile: each field changed from nothing. The profile's id is the user's, which
      // the path already carries, so there is no created id.
      const changes: audit.Details = {}
      audit.changed(changes, "bio", before, after.bio)
      audit.setDetails(reply, changes)
      return after
    }
  )
}
