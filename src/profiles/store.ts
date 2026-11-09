import { type Db, trackDb, transaction } from "../db.ts"
import type { Profile } from "../schemas.ts"

/** People's profiles, by user id. */
export const profilesStore = (db: Db) => {
  const find = db.prepare(
    `SELECT user_id, bio, created_at, updated_at FROM profiles WHERE user_id = ?`
  )
  const insertIfAbsent = db.prepare(
    `INSERT INTO profiles (user_id, bio, created_at, updated_at) VALUES (?, '', ?, ?)
     ON CONFLICT (user_id) DO NOTHING`
  )
  const upsert = db.prepare(
    `INSERT INTO profiles (user_id, bio, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET bio = excluded.bio, updated_at = excluded.updated_at
     RETURNING user_id, bio, created_at, updated_at`
  )
  const remove = db.prepare(`DELETE FROM profiles WHERE user_id = ?`)

  return {
    /** The person's profile, made empty at `now` if they have none: two first reads make one. */
    getOrCreate: (userId: string, now: string): Profile =>
      trackDb("profiles.get_or_create", () => {
        insertIfAbsent.run(userId, now, now)
        return find.get(userId) as Profile
      }),

    /** Writes the person's bio at `now`, making their profile if they have none; with the bio it had, or null when it's new. */
    upsert: (userId: string, bio: string, now: string): { before: string | null; after: Profile } =>
      trackDb("profiles.upsert", () =>
        transaction(db, () => {
          const before = find.get(userId) as Profile | undefined
          const after = upsert.get(userId, bio, now, now) as Profile
          return { before: before?.bio ?? null, after }
        })
      ),

    /** Deletes the person's profile, with their account. Deleting none is fine, so it can run again. */
    delete: (userId: string): void => {
      trackDb("profiles.delete", () => remove.run(userId))
    }
  }
}

export type ProfilesStore = ReturnType<typeof profilesStore>
