import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type Db = DatabaseSync

export const connect = (databasePath: string): Db => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true })
  const db = new DatabaseSync(databasePath, { timeout: 5000 })
  db.exec("PRAGMA journal_mode = WAL")
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

    -- A project is a Plat5 node: its tasks are keyed by its id and removed when purged.
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      assignee_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks (project_id);

    -- Last event acted on in identity's lifecycle log (single row, opaque decimal string).
    CREATE TABLE IF NOT EXISTS feed_cursors (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      event_id TEXT NOT NULL
    );
  `)
}

/** Runs `fn` inside a single SQLite BEGIN IMMEDIATE transaction. */
export const transaction = <T>(db: Db, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = fn()
    db.exec("COMMIT")
    return result
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}
