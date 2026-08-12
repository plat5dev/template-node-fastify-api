import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { recordDbOperation } from "./metrics.js"

export type Db = Database.Database

export const connect = (databasePath: string): Db => {
  mkdirSync(dirname(databasePath), { recursive: true })
  const db = new Database(databasePath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  return db
}

export const migrate = (db: Db): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_by_member_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS projects_organization_id_idx
      ON projects (organization_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      created_by_member_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks (project_id);
    CREATE INDEX IF NOT EXISTS tasks_organization_id_idx ON tasks (organization_id);
  `)
}

export const trackDb = <T>(operation: string, fn: () => T): T => {
  const started = performance.now()
  try {
    const result = fn()
    recordDbOperation(operation, (performance.now() - started) / 1000, null)
    return result
  } catch (err) {
    recordDbOperation(operation, (performance.now() - started) / 1000, err)
    throw err
  }
}
