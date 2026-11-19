import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox"
import * as audit from "./audit.ts"
import { type Db, transaction } from "./db.ts"
import {
  errorSchema,
  type Profile,
  profileParamsSchema,
  profileSchema,
  profileUpdateSchema
} from "./schemas.ts"

export const profilesStore = (db: Db) => {
  const findStmt = db.prepare(
    `SELECT user_id, bio, created_at, updated_at FROM profiles WHERE user_id = ?`
  )
  const insertIfAbsentStmt = db.prepare(
    `INSERT INTO profiles (user_id, bio, created_at, updated_at) VALUES (?, '', ?, ?)
     ON CONFLICT (user_id) DO NOTHING`
  )
  const upsertStmt = db.prepare(
    `INSERT INTO profiles (user_id, bio, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET bio = excluded.bio, updated_at = excluded.updated_at
     RETURNING user_id, bio, created_at, updated_at`
  )
  const deleteStmt = db.prepare(`DELETE FROM profiles WHERE user_id = ?`)

  return {
    getOrCreate: (userId: string, now: string): Profile => {
      insertIfAbsentStmt.run(userId, now, now)
      return findStmt.get(userId) as Profile
    },

    upsert: (userId: string, bio: string, now: string): { before: string | null; after: Profile } =>
      transaction(db, () => {
        const before = findStmt.get(userId) as Profile | undefined
        const after = upsertStmt.get(userId, bio, now, now) as Profile
        return { before: before?.bio ?? null, after }
      }),

    delete: (userId: string): void => {
      deleteStmt.run(userId)
    }
  }
}

export type ProfilesStore = ReturnType<typeof profilesStore>

export const profileRoutes: FastifyPluginAsyncTypebox<{ store: ProfilesStore }> = async (
  app,
  { store }
) => {
  const path = "/users/:user_id/profile"
  const tags = ["Profiles"]

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
          400: errorSchema("Malformed JSON body."),
          422: errorSchema("Invalid bio.")
        }
      }
    },
    async (req, reply) => {
      const { before, after } = store.upsert(
        req.params.user_id,
        req.body.bio,
        new Date().toISOString()
      )
      const changes: audit.AuditDetails = {}
      audit.changed(changes, "bio", before, after.bio)
      audit.setDetails(reply, changes)
      return after
    }
  )
}
