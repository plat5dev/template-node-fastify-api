import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connect, migrate } from "./db.js"

test("feed_cursors holds one cursor, and migrating again keeps it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "api-db-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = connect(join(dir, "app.db"))
  t.after(() => db.close())
  migrate(db)

  db.prepare(`INSERT INTO feed_cursors (id, event_id) VALUES (1, '813')`).run()
  assert.throws(
    () => db.prepare(`INSERT INTO feed_cursors (id, event_id) VALUES (2, '814')`).run(),
    "a second cursor was taken"
  )
  migrate(db)
  assert.deepEqual(db.prepare(`SELECT id, event_id FROM feed_cursors`).all(), [
    { id: 1, event_id: "813" }
  ])
})
