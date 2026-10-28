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
      bio TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- An environment is a Plat5 node: its tasks are keyed by its id, and go when it's purged.
    -- assignee_id is a member id in the environment's tree, or NULL.
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      assignee_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tasks_environment_id_idx ON tasks (environment_id);

    -- The last event acted on in each of identity's feeds: one row per feed, an opaque
    -- decimal string from that feed's own sequence.
    CREATE TABLE IF NOT EXISTS feed_cursors (
      feed TEXT PRIMARY KEY NOT NULL CHECK (feed IN ('tree', 'user')),
      event_id TEXT NOT NULL
    );
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
