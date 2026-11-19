import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { connect, migrate } from "./db.ts"
import { decodePage, type LifecycleEvent, lifecycleReader, TYPES } from "./lifecycle.ts"
import { profilesStore } from "./profiles.ts"
import { tasksStore } from "./tasks.ts"
import { memoryLogger } from "./testing.ts"

const purged = "01jd8x3k7q0000000000000001"
const kept = "01jd8x3k7q0000000000000002"
const gone = "01jd8x3k7q00000000000000u1"
const stays = "01jd8x3k7q00000000000000u2"
const fresh = "01jd8x3k7q00000000000000u3"

type Served = LifecycleEvent & { type: string }

const cursorAheadBody = JSON.stringify({
  error: {
    type: "invalid_request_error",
    code: "CURSOR_AHEAD",
    message: "Cursor ahead of log.",
    request_id: null,
    details: null
  }
})

class FakeIdentity {
  wait = 50
  fail: { status: number; body?: string }[] = []
  readonly asked: string[] = []
  readonly types: string[] = []
  readonly limits: string[] = []
  url = ""
  private readonly added = new Set<() => void>()
  private readonly waiting: (() => void)[] = []
  private readonly events: Served[]

  constructor(events: Served[] = []) {
    this.events = events
  }

  add(event: Served): void {
    this.events.push(event)
    for (const wake of [...this.added]) wake()
  }

  nextWait(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private page(after: string, types: string[]): { events: Served[]; more: boolean } {
    const match = this.events.filter((e) => Number(e.id) > Number(after) && types.includes(e.type))
    return { events: match.slice(0, 2), more: match.length > 2 }
  }

  async listen(t: TestContext): Promise<void> {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://identity")
      if (url.pathname !== "/internal/events") return res.writeHead(404).end()
      const after = url.searchParams.get("after") ?? ""
      const types = (url.searchParams.get("types") ?? "").split(",")
      this.asked.push(after)
      this.types.push(url.searchParams.get("types") ?? "")
      this.limits.push(url.searchParams.get("limit") ?? "")

      const failure = this.fail.shift()
      if (failure !== undefined) {
        res.writeHead(failure.status, { "content-type": "application/json" })
        return res.end(failure.body ?? "")
      }
      if (Number(after) > Math.max(0, ...this.events.map((e) => Number(e.id)))) {
        res.writeHead(409, { "content-type": "application/json" })
        return res.end(cursorAheadBody)
      }

      let page = this.page(after, types)
      const deadline = performance.now() + this.wait
      while (page.events.length === 0) {
        const left = deadline - performance.now()
        const outcome = await new Promise<"added" | "timeout" | "closed">((resolve) => {
          const done = (o: "added" | "timeout" | "closed") => {
            this.added.delete(onAdd)
            clearTimeout(timer)
            res.off("close", onClose)
            resolve(o)
          }
          const onAdd = () => done("added")
          const onClose = () => done("closed")
          const timer = setTimeout(() => done("timeout"), Math.max(0, left))
          this.added.add(onAdd)
          res.on("close", onClose)
          this.waiting.shift()?.()
        })
        if (outcome === "closed") return
        if (outcome === "timeout") return res.writeHead(204).end()
        page = this.page(after, types)
      }

      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ events: page.events, has_more: page.more }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    t.after(() => {
      server.closeAllConnections()
      server.close()
    })
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
}

const sampleLog = () =>
  new FakeIdentity([
    { id: "7", type: "node.created", kind: "project", node_id: purged },
    { id: "8", type: "user.created", user_id: fresh },
    { id: "9", type: "node.purged", kind: "organization", node_id: kept },
    { id: "10", type: "member.removed" },
    { id: "12", type: "node.purged", kind: "project", node_id: purged },
    { id: "13", type: "user.deleted", user_id: gone },
    { id: "20", type: "node.deleted", kind: "project", node_id: kept }
  ])

const setup = async (t: TestContext, identity: FakeIdentity, retryMs = 10) => {
  const { log, entries } = memoryLogger()
  await identity.listen(t)
  const db = connect(":memory:")
  migrate(db)
  t.after(() => db.close())
  const tasks = tasksStore(db)
  const profiles = profilesStore(db)
  const consumer = lifecycleReader({ identityUrl: identity.url, db, tasks, profiles, log, retryMs })

  const seed = () => {
    for (const [id, projectId] of [
      ["01jd8x3k7q0000000000000t01", purged],
      ["01jd8x3k7q0000000000000t02", kept]
    ] as const) {
      tasks.insert({
        id,
        project_id: projectId,
        title: "t",
        status: "todo",
        assignee_id: null,
        created_by: "01jd8x3k7q00000000000000mm",
        created_at: "now",
        updated_at: "now"
      })
    }
    profiles.upsert(gone, "hi", "now")
    profiles.upsert(stays, "hi", "now")
  }

  const countTasks = (projectId: string) =>
    tasks.list(projectId, { limit: 100, startingAfter: "" }).items.length
  const hasProfile = (userId: string) =>
    db.prepare(`SELECT 1 FROM profiles WHERE user_id = ?`).get(userId) !== undefined

  const assertCleaned = () => {
    assert.equal(countTasks(purged), 0)
    assert.equal(countTasks(kept), 1)
    assert.equal(hasProfile(gone), false)
    assert.equal(hasProfile(stays), true)
    assert.equal(hasProfile(fresh), false)
  }

  const runUntil = async (cond: () => boolean) => {
    const stopping = new AbortController()
    const done = consumer.run(stopping.signal)
    const deadline = performance.now() + 5_000
    while (!cond()) {
      if (performance.now() > deadline) {
        stopping.abort()
        await done
        assert.fail("condition not met in 5s")
      }
      await sleep(5)
    }
    stopping.abort()
    await done
  }

  return { consumer, db, entries, seed, countTasks, hasProfile, assertCleaned, runUntil }
}

test("applies node.purged (project) and user.deleted, advancing cursor per page", async (t) => {
  const identity = sampleLog()
  const s = await setup(t, identity)
  s.seed()

  await s.consumer.step()
  await s.consumer.step()
  s.assertCleaned()
  assert.equal(s.consumer.cursor(), "13")
  assert.deepEqual(identity.asked, ["", "12"])
  assert.ok(identity.types.every((v) => v === TYPES))
  assert.ok(identity.limits.every((v) => v === "100"))

  // 204 at head keeps cursor unchanged.
  await s.consumer.step()
  assert.equal(s.consumer.cursor(), "13")
})

test("long-poll wakes when a matching event arrives", async (t) => {
  const identity = sampleLog()
  identity.wait = 5_000
  const s = await setup(t, identity)
  s.seed()
  await s.consumer.step()
  await s.consumer.step()

  void (async () => {
    await identity.nextWait()
    identity.add({ id: "21", type: "node.created" })
    await identity.nextWait()
    identity.add({ id: "22", type: "user.deleted", user_id: stays })
  })()

  const started = performance.now()
  await s.consumer.step()
  assert.ok(performance.now() - started < 2_000)
  assert.equal(s.hasProfile(stays), false)
  assert.equal(s.consumer.cursor(), "22")
})

test("retries errors (503, 500, non-CURSOR_AHEAD 409) without advancing cursor", async (t) => {
  const identity = sampleLog()
  identity.fail = [
    { status: 503 },
    { status: 409, body: JSON.stringify({ error: { code: "CONFLICT" } }) },
    { status: 500 }
  ]
  const s = await setup(t, identity)
  s.seed()

  await assert.rejects(s.consumer.step(), /answered 503/)
  await assert.rejects(s.consumer.step(), /answered 409/)
  assert.equal(s.consumer.cursor(), "")

  await s.runUntil(() => s.consumer.cursor() === "13")
  s.assertCleaned()
  assert.ok(s.entries.some((e) => e.level === "error" && e.message === "lifecycle read failed"))
})

test("409 CURSOR_AHEAD resets cursor and replays from first event without retry delay", async (t) => {
  const identity = sampleLog()
  const s = await setup(t, identity, 60_000)
  s.seed()
  s.db.exec(`INSERT INTO feed_cursors (id, event_id) VALUES (1, '99')`)

  await s.runUntil(() => s.consumer.cursor() === "13")
  s.assertCleaned()
  assert.deepEqual(identity.asked.slice(0, 3), ["99", "", "12"])
  assert.ok(s.entries.some((e) => e.level === "warn" && e.cursor === "99"))
  assert.equal(s.entries.some((e) => e.level === "error"), false)
})

test("abort cancels an in-flight long-poll cleanly without error logs", async (t) => {
  const identity = sampleLog()
  identity.wait = 60_000
  const s = await setup(t, identity)
  await s.consumer.step()
  await s.consumer.step()

  const stopping = new AbortController()
  const waiting = identity.nextWait()
  const done = s.consumer.run(stopping.signal)
  await waiting
  stopping.abort()

  const late = Symbol()
  const outcome = await Promise.race([done, sleep(2_000, late)])
  assert.notEqual(outcome, late)
  assert.equal(s.entries.some((e) => e.level === "error"), false)
})

test("deletes and cursor advance commit atomically in one transaction", async (t) => {
  const identity = sampleLog()
  const s = await setup(t, identity)
  s.seed()
  s.db.exec(
    `CREATE TRIGGER no_cursor BEFORE INSERT ON feed_cursors BEGIN SELECT RAISE(ABORT, 'no'); END`
  )

  await assert.rejects(s.consumer.step())
  await assert.rejects(s.consumer.step())
  assert.equal(s.countTasks(purged), 1)
  assert.equal(s.consumer.cursor(), "")
})

test("decodePage skips events without string id and rejects non-array payloads", () => {
  assert.deepEqual(decodePage({ events: [] }), [])
  assert.deepEqual(
    decodePage({
      events: [
        { id: "7", Type: "node.purged", kind: "project", extra: 1 },
        { id: "8", type: "user.deleted", user_id: 5 },
        { id: "", type: "user.deleted" },
        null
      ]
    }),
    [
      { id: "7", type: undefined, kind: "project", node_id: undefined, user_id: undefined },
      { id: "8", type: "user.deleted", kind: undefined, node_id: undefined, user_id: undefined }
    ]
  )
  for (const bad of [[], null, {}, { events: null }]) {
    assert.throws(() => decodePage(bad))
  }
})
