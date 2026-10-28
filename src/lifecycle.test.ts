import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { connect, migrate } from "./db.js"
import { LifecycleConsumer, type TreeEvent, type UserEvent } from "./lifecycle.js"
import { ProfilesStore } from "./profiles/store.js"
import { TasksStore } from "./tasks/store.js"

const purged = "01jd8x3k7q0000000000000001"
const kept = "01jd8x3k7q0000000000000002"
const gone = "01jd8x3k7q00000000000000u1"
const stays = "01jd8x3k7q00000000000000u2"
const fresh = "01jd8x3k7q00000000000000u3"

/** One feed as identity serves it: its events, two to a page, and each cursor asked for. */
type Served = { key: string; events: { id: string }[]; asked: string[]; fail: boolean }

/** Identity, serving the tree and user feeds at their paths. */
const serveIdentity = async (t: TestContext, tree: TreeEvent[], user: UserEvent[]) => {
  const feeds: Record<string, Served> = {
    "/internal/tree-events": { key: "tree_events", events: tree, asked: [], fail: false },
    "/internal/user-events": { key: "user_events", events: user, asked: [], fail: false }
  }
  const limits: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://identity")
    const feed = feeds[url.pathname]
    if (!feed) return res.writeHead(404).end()
    if (feed.fail) return res.writeHead(503).end()
    const after = url.searchParams.get("starting_after") ?? ""
    feed.asked.push(after)
    limits.push(url.searchParams.get("limit") ?? "")
    const rest = feed.events.filter((e) => Number(e.id) > Number(after))
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ [feed.key]: rest.slice(0, 2), has_more: rest.length > 2 }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tree: feeds["/internal/tree-events"]!,
    user: feeds["/internal/user-events"]!,
    limits
  }
}

const setup = async (t: TestContext, tree: TreeEvent[], user: UserEvent[]) => {
  // The consumer's lines, to read and to keep out of the test output.
  const logs = t.mock.method(console, "log", () => {})
  const identity = await serveIdentity(t, tree, user)
  const db = connect(":memory:")
  migrate(db)
  t.after(() => db.close())
  const tasks = new TasksStore(db)
  const profiles = new ProfilesStore(db)
  const consumer = new LifecycleConsumer(identity.url, db, tasks, profiles)

  const addTask = (id: string, environmentId: string) =>
    tasks.insert({
      id,
      environment_id: environmentId,
      title: "t",
      status: "todo",
      assignee_id: null,
      created_by: "01jd8x3k7q00000000000000mm",
      created_at: "now",
      updated_at: "now"
    })
  const count = (environmentId: string) =>
    tasks.listByEnvironment(environmentId, { limit: 100, startingAfter: "" }).items.length
  const addProfile = (userId: string) =>
    profiles.insert({ user_id: userId, bio: "hi", created_at: "now", updated_at: "now" })
  const hasProfile = (userId: string) => profiles.findByUserId(userId) !== null
  const cursor = (feed: "tree" | "user") => {
    const row = db.prepare(`SELECT event_id FROM feed_cursors WHERE feed = ?`).get(feed) as
      | { event_id: string }
      | undefined
    return row?.event_id ?? ""
  }
  const logged = (): Record<string, unknown>[] =>
    logs.mock.calls.map((call) => JSON.parse(String(call.arguments[0])))

  return { identity, consumer, db, addTask, count, addProfile, hasProfile, cursor, logged }
}

test("tree feed: a purged environment's tasks go, read from its cursor", async (t) => {
  const s = await setup(
    t,
    [
      { id: "7", type: "node.created", kind: "environment", node_id: purged },
      { id: "8", type: "node.deleted", kind: "environment", node_id: kept },
      { id: "9", type: "member.removed" } as TreeEvent,
      { id: "10", type: "node.purged", kind: "organization", node_id: kept },
      { id: "11", type: "node.purged", kind: "environment", node_id: purged }
    ],
    []
  )
  s.addTask("01jd8x3k7q0000000000000t01", purged)
  s.addTask("01jd8x3k7q0000000000000t02", kept)

  await s.consumer.poll()
  assert.equal(s.count(purged), 0)
  assert.equal(s.count(kept), 1)
  // Three pages in one poll: has_more reads again at once, from each page's last id.
  assert.deepEqual(s.identity.tree.asked, ["", "8", "10"])
  assert.ok(s.identity.limits.every((limit) => limit === "100"))
  assert.equal(s.cursor("tree"), "11")

  // The next poll starts from the saved cursor.
  await s.consumer.poll()
  assert.equal(s.identity.tree.asked.at(-1), "11")
})

test("user feed: user.deleted deletes that profile, from the user cursor", async (t) => {
  const s = await setup(
    t,
    [{ id: "900", type: "node.created", kind: "environment", node_id: kept }],
    [
      { id: "1", type: "user.created", user_id: fresh },
      { id: "2", type: "user.deleted", user_id: gone },
      { id: "3", type: "user.created", user_id: stays }
    ]
  )
  s.addProfile(gone)
  s.addProfile(stays)

  await s.consumer.poll()
  assert.equal(s.hasProfile(gone), false, "deleted person's profile is kept")
  assert.equal(s.hasProfile(stays), true, "another person's profile is gone")
  assert.equal(s.hasProfile(fresh), false, "user.created made a profile")
  assert.deepEqual(s.identity.user.asked, ["", "2"])
  assert.equal(s.cursor("tree"), "900")
  assert.equal(s.cursor("user"), "3")

  // Each feed is asked from its own cursor.
  await s.consumer.poll()
  assert.equal(s.identity.tree.asked.at(-1), "900")
  assert.equal(s.identity.user.asked.at(-1), "3")
})

for (const failing of ["tree", "user"] as const) {
  test(`the ${failing} feed failing doesn't stop the other`, async (t) => {
    const s = await setup(
      t,
      [{ id: "5", type: "node.purged", kind: "environment", node_id: purged }],
      [{ id: "6", type: "user.deleted", user_id: gone }]
    )
    s.identity[failing].fail = true
    s.addTask("01jd8x3k7q0000000000000t01", purged)
    s.addProfile(gone)

    await s.consumer.poll()
    assert.equal(s.count(purged) === 0, failing !== "tree")
    assert.equal(s.hasProfile(gone), failing === "user")
    // The failed feed keeps its cursor, to be read again on the next poll, and says which
    // feed failed.
    assert.equal(s.cursor(failing), "")
    const failures = s.logged().filter((line) => line.message === "lifecycle poll failed")
    assert.deepEqual(
      failures.map((line) => [line.level, line.feed]),
      [["error", failing]]
    )
  })
}

test("reading an event twice is harmless", async (t) => {
  const s = await setup(
    t,
    [{ id: "3", type: "node.purged", kind: "environment", node_id: purged }],
    [{ id: "4", type: "user.deleted", user_id: gone }]
  )
  s.addTask("01jd8x3k7q0000000000000t01", purged)
  s.addProfile(gone)

  for (let i = 0; i < 2; i++) {
    await s.consumer.poll()
    // Forget the cursors, so the next poll gets the same events.
    s.db.exec(`DELETE FROM feed_cursors`)
  }
  assert.equal(s.count(purged), 0)
  assert.equal(s.hasProfile(gone), false)
  assert.deepEqual(s.identity.tree.asked, ["", ""])
  assert.deepEqual(s.identity.user.asked, ["", ""])
  assert.equal(
    s.logged().some((line) => line.level === "error"),
    false
  )
})
