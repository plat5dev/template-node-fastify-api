import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connect, migrate, transaction } from "./db.ts"

test("feed_cursors holds one cursor, and migrating again keeps it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "api-db-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = connect(join(dir, "app.db"))
  t.after(() => db.close())
  migrate(db)
  db.prepare(`INSERT INTO feed_cursors (id, event_id) VALUES (1, '813')`).run()
  assert.throws(() => db.prepare(`INSERT INTO feed_cursors (id, event_id) VALUES (2, '814')`).run())
  migrate(db)
  assert.deepEqual(
    db
      .prepare(`SELECT id, event_id FROM feed_cursors`)
      .all()
      .map((row) => ({ ...row })),
    [{ id: 1, event_id: "813" }]
  )
})

test("a transaction commits when it returns, and rolls back when it throws", (t) => {
  const db = connect(":memory:")
  t.after(() => db.close())
  migrate(db)
  const save = db.prepare(
    `INSERT INTO feed_cursors (id, event_id) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id`
  )
  const cursor = () =>
    (db.prepare(`SELECT event_id FROM feed_cursors`).get() as { event_id: string } | undefined)
      ?.event_id
  transaction(db, () => save.run("1"))
  assert.throws(() =>
    transaction(db, () => {
      save.run("2")
      throw new Error("no")
    })
  )
  assert.equal(cursor(), "1")
  assert.equal(db.isTransaction, false)
})
