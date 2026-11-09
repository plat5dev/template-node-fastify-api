import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { connect, migrate } from "./db.ts"
import { decodePage, type Event, lifecycleReader, TYPES } from "./lifecycle.ts"
import { profilesStore } from "./profiles/store.ts"
import { tasksStore } from "./tasks/store.ts"

const purged = "01jd8x3k7q0000000000000001"
const kept = "01jd8x3k7q0000000000000002"
const gone = "01jd8x3k7q00000000000000u1"
const stays = "01jd8x3k7q00000000000000u2"
const fresh = "01jd8x3k7q00000000000000u3"

type Served = Event & { type: string }

/**
 * Identity, serving the one lifecycle log at /internal/events as identity does: types
 * filters, two events to a page, no after is answered at once, and with after it waits for
 * a matching event up to `wait`, then answers 204. The first requests answer `fail`'s
 * statuses, one each.
 */
class Identity {
  wait = 50
  /** Statuses for the first requests. */
  fail: number[] = []
  /** Each request's after, types and limit. */
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

  /** Appends an event and wakes any waiting read. */
  add(event: Served): void {
    this.events.push(event)
    for (const wake of [...this.added]) wake()
  }

  /** Resolves when a read is next waiting. */
  nextWait(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  /** The events after `after` that match `types`, at most two, and whether more follow. */
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
      if (failure !== undefined) return res.writeHead(failure).end()
      let page = this.page(after, types)
      const deadline = performance.now() + this.wait
      while (after !== "" && page.events.length === 0) {
        const left = deadline - performance.now()
        const outcome = await new Promise<"added" | "timeout" | "closed">((resolve) => {
          const done = (outcome: "added" | "timeout" | "closed") => {
            this.added.delete(onAdd)
            clearTimeout(timer)
            res.off("close", onClose)
            resolve(outcome)
          }
          const onAdd = () => done("added")
          const onClose = () => done("closed")
          const timer = setTimeout(() => done("timeout"), Math.max(0, left))
          this.added.add(onAdd)
          res.on("close", onClose)
          // Tell a test the read is waiting, if it's listening.
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

const setup = async (t: TestContext, identity: Identity, retryMs = 10) => {
  // The consumer's lines, to read and to keep out of the test output.
  const logs = t.mock.method(console, "log", () => {})
  await identity.listen(t)
  const db = connect(":memory:")
  migrate(db)
  t.after(() => db.close())
  const tasks = tasksStore(db)
  const profiles = profilesStore(db)
  const consumer = lifecycleReader({ identityUrl: identity.url, db, tasks, profiles, retryMs })

  const addTask = (id: string, projectId: string) =>
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
  const count = (projectId: string) =>
    tasks.list(projectId, { limit: 100, startingAfter: "" }).items.length
  const addProfile = (userId: string) => profiles.upsert(userId, "hi", "now")
  const hasProfile = (userId: string) =>
    db.prepare(`SELECT 1 FROM profiles WHERE user_id = ?`).get(userId) !== undefined
  const cursor = consumer.cursor
  const logged = (): Record<string, unknown>[] =>
    logs.mock.calls.map((call) => JSON.parse(String(call.arguments[0])))

  const seed = () => {
    addTask("01jd8x3k7q0000000000000t01", purged)
    addTask("01jd8x3k7q0000000000000t02", kept)
    addProfile(gone)
    addProfile(stays)
  }
  const checkActed = () => {
    assert.equal(count(purged), 0, "purged project's tasks are kept")
    assert.equal(count(kept), 1, "other project's tasks are gone")
    assert.equal(hasProfile(gone), false, "deleted person's profile is kept")
    assert.equal(hasProfile(stays), true, "another person's profile is gone")
    assert.equal(hasProfile(fresh), false, "user.created made a profile")
  }

  /** Runs the consumer until `cond` holds, then stops it and waits for run to return. */
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
    await returnsWithin(done, 2_000)
  }

  return {
    consumer,
    db,
    addProfile,
    count,
    hasProfile,
    cursor,
    logged,
    seed,
    checkActed,
    runUntil
  }
}

const returnsWithin = async (done: Promise<void>, ms: number) => {
  const late = Symbol()
  const outcome = await Promise.race([done, sleep(ms, late)])
  assert.notEqual(outcome, late, "run didn't return when it was stopped")
}

const theLog = () =>
  new Identity([
    { id: "7", type: "node.created", kind: "project", node_id: purged },
    { id: "8", type: "user.created", user_id: fresh },
    { id: "9", type: "node.purged", kind: "organization", node_id: kept },
    { id: "10", type: "member.removed" },
    { id: "12", type: "node.purged", kind: "project", node_id: purged },
    { id: "13", type: "user.deleted", user_id: gone },
    { id: "20", type: "node.deleted", kind: "project", node_id: kept }
  ])

test("acts on each page and advances the cursor", async (t) => {
  const identity = theLog()
  const s = await setup(t, identity)
  s.seed()

  // No cursor yet: from the first event, then from each page's last id.
  for (let i = 0; i < 2; i++) {
    assert.equal(await s.consumer.step(), true, "a page should be followed at once by another ask")
  }
  s.checkActed()
  assert.equal(s.cursor(), "13")
  assert.deepEqual(identity.asked, ["", "12"])
  assert.ok(identity.types.every((types) => types === "node.purged,user.deleted"))
  assert.equal(TYPES, "node.purged,user.deleted")
  assert.ok(identity.limits.every((limit) => limit === "100"))
})

test("a 204 is asked again at once", async (t) => {
  const identity = theLog()
  const s = await setup(t, identity)
  await s.consumer.step()
  await s.consumer.step()

  // At the head: identity waits, answers 204, and nothing changes.
  assert.equal(await s.consumer.step(), true, "a 204 should be followed at once by another ask")
  assert.equal(s.cursor(), "13")
  assert.equal(identity.asked.at(-1), "13")
})

test("a waiting read gets a new event", async (t) => {
  const identity = theLog()
  identity.wait = 5_000
  const s = await setup(t, identity)
  await s.consumer.step()
  await s.consumer.step()

  void (async () => {
    await identity.nextWait()
    identity.add({ id: "21", type: "node.created" }) // not asked for: the wait goes on
    await identity.nextWait()
    identity.add({ id: "22", type: "user.deleted", user_id: stays })
  })()
  const started = performance.now()
  await s.consumer.step()
  assert.ok(performance.now() - started < 2_000, "the read waited out its timeout")
  assert.equal(s.hasProfile(stays), false, "the new event wasn't acted on")
  assert.equal(s.cursor(), "22")
})

test("an error is retried", async (t) => {
  const identity = theLog()
  // Identity's Postgres unavailable is a 503; any other failure, a 500.
  identity.fail = [503, 500]
  const s = await setup(t, identity)
  s.seed()

  await assert.rejects(s.consumer.step(), /answered 503/)
  assert.equal(s.cursor(), "", "a failed read moved the cursor")

  // run logs the 500, waits its retry, and reads on.
  await s.runUntil(() => s.cursor() === "13")
  s.checkActed()
  assert.deepEqual(identity.asked.slice(0, 4), ["", "", "", "12"])
  const failures = s.logged().filter((line) => line.message === "lifecycle read failed")
  assert.deepEqual(
    failures.map((line) => [line.level, line.error_message]),
    [["error", "lifecycle log answered 500"]]
  )
})

test("an empty log is not asked in a tight loop", async (t) => {
  const identity = new Identity()
  const s = await setup(t, identity, 50)
  assert.equal(
    await s.consumer.step(),
    false,
    "an immediate empty answer should wait before asking again"
  )
  await s.consumer.run(AbortSignal.timeout(120))
  assert.ok(identity.asked.length <= 5, `asked ${identity.asked.length} times in 120ms`)
})

test("stopping cancels the read in flight", async (t) => {
  const identity = theLog()
  identity.wait = 60_000
  const s = await setup(t, identity)
  await s.consumer.step()
  await s.consumer.step()

  const stopping = new AbortController()
  const waiting = identity.nextWait()
  const done = s.consumer.run(stopping.signal)
  await waiting
  stopping.abort()
  await returnsWithin(done, 2_000)
  assert.equal(
    s.logged().some((line) => line.level === "error"),
    false,
    "stopping logged an error"
  )
})

test("replay changes nothing", async (t) => {
  const identity = theLog()
  const s = await setup(t, identity)
  s.seed()
  await s.runUntil(() => s.cursor() === "13")

  // Reset the cursor, as the README says, and read the log again from its first event.
  s.db.exec(`DELETE FROM feed_cursors`)
  const before = identity.asked.length
  await s.runUntil(() => s.cursor() === "13")
  s.checkActed()
  assert.equal(identity.asked[before], "", "replay should ask from the first event")
  assert.ok(
    s.logged().some((line) => line.message === "following the lifecycle log from its first event")
  )
})

test("a page commits with its cursor", async (t) => {
  const identity = theLog()
  const s = await setup(t, identity)
  s.seed()
  // The cursor can't be saved, so the page's deletes roll back with it.
  s.db.exec(
    `CREATE TRIGGER no_cursor BEFORE INSERT ON feed_cursors BEGIN SELECT RAISE(ABORT, 'no'); END`
  )
  for (let i = 0; i < 2; i++) {
    await assert.rejects(s.consumer.step(), "want an error when the cursor can't be saved")
  }
  assert.equal(s.count(purged), 1, "the purge's delete wasn't rolled back")
  assert.equal(s.cursor(), "")
})

test("a page: its events by their exact keys, an event without an id skipped", () => {
  assert.deepEqual(decodePage({ events: [] }), [])
  const events = decodePage({
    events: [
      { id: "7", Type: "node.purged", kind: "project", NODE_ID: "x", extra: 1 },
      { id: "8", type: "user.deleted", user_id: 5 },
      { type: "user.deleted", user_id: "u" },
      { id: "", type: "user.deleted", user_id: "u" },
      null,
      "x"
    ],
    has_more: "ignored"
  })
  assert.deepEqual(events, [
    { id: "7", type: undefined, kind: "project", node_id: undefined, user_id: undefined },
    { id: "8", type: "user.deleted", kind: undefined, node_id: undefined, user_id: undefined }
  ])
  for (const page of [[], null, {}, { events: null }, { events: {} }]) {
    assert.throws(() => decodePage(page), JSON.stringify(page))
  }
})

test("an event without what it acts on, or with a kind not exactly project, changes nothing", async (t) => {
  const identity = new Identity([
    { id: "1", type: "node.purged", kind: "project" },
    { id: "2", type: "user.deleted" },
    { id: "3", type: "node.purged", kind: "Project", node_id: purged }
  ])
  const s = await setup(t, identity)
  s.seed()
  assert.equal(await s.consumer.step(), true)
  assert.equal(await s.consumer.step(), true)
  assert.equal(s.cursor(), "3")
  assert.equal(s.count(purged), 1)
  assert.equal(s.hasProfile(gone), true)
})
