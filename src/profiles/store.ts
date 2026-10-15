import type { Db } from "../db.js"
import { trackDb } from "../db.js"
import type { Profile } from "../schemas/common.js"

export class ProfilesStore {
  constructor(private readonly db: Db) {}

  findByUserId(userId: string): Profile | null {
    return trackDb("profiles.find", () => {
      const row = this.db
        .prepare(
          `SELECT user_id, bio, created_at, updated_at
           FROM profiles WHERE user_id = ?`
        )
        .get(userId) as Profile | undefined
      return row ?? null
    })
  }

  insert(p: Profile): void {
    trackDb("profiles.insert", () => {
      this.db
        .prepare(
          `INSERT INTO profiles (user_id, bio, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(p.user_id, p.bio, p.created_at, p.updated_at)
    })
  }

  update(p: Profile): void {
    trackDb("profiles.update", () => {
      this.db
        .prepare(
          `UPDATE profiles SET bio = ?, updated_at = ?
           WHERE user_id = ?`
        )
        .run(p.bio, p.updated_at, p.user_id)
    })
  }
}
