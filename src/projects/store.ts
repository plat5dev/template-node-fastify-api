import type { Db } from "../db.js"
import { trackDb } from "../db.js"
import type { Project } from "../schemas/common.js"

export class ProjectsStore {
  constructor(private readonly db: Db) {}

  listByOrg(organizationId: string): Project[] {
    return trackDb("projects.list", () => {
      return this.db
        .prepare(
          `SELECT id, organization_id, name, description, created_by_membership_id, created_at, updated_at
           FROM projects WHERE organization_id = ? ORDER BY created_at DESC`
        )
        .all(organizationId) as Project[]
    })
  }

  findInOrg(organizationId: string, projectId: string): Project | null {
    return trackDb("projects.find", () => {
      const row = this.db
        .prepare(
          `SELECT id, organization_id, name, description, created_by_membership_id, created_at, updated_at
           FROM projects WHERE id = ? AND organization_id = ?`
        )
        .get(projectId, organizationId) as Project | undefined
      return row ?? null
    })
  }

  insert(p: Project): void {
    trackDb("projects.insert", () => {
      this.db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, description, created_by_membership_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          p.id,
          p.organization_id,
          p.name,
          p.description,
          p.created_by_membership_id,
          p.created_at,
          p.updated_at
        )
    })
  }

  update(p: Project): void {
    trackDb("projects.update", () => {
      this.db
        .prepare(
          `UPDATE projects SET name = ?, description = ?, updated_at = ?
           WHERE id = ? AND organization_id = ?`
        )
        .run(p.name, p.description, p.updated_at, p.id, p.organization_id)
    })
  }

  delete(organizationId: string, projectId: string): boolean {
    return trackDb("projects.delete", () => {
      const res = this.db
        .prepare(`DELETE FROM projects WHERE id = ? AND organization_id = ?`)
        .run(projectId, organizationId)
      return res.changes > 0
    })
  }
}
