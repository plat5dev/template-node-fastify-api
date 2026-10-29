import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { connect, migrate } from "./db.js"
import { createInternalServer } from "./internal.js"

const serve = async (t: TestContext) => {
  const db = connect(":memory:")
  migrate(db)
  const server = createInternalServer(db)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { db, url }
}

test("health: live, and ready while the database answers", async (t) => {
  const { db, url } = await serve(t)
  let res = await fetch(`${url}/health/live`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: "healthy" })
  res = await fetch(`${url}/health/ready`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: "healthy" })
  db.close()
  res = await fetch(`${url}/health/ready`)
  assert.equal(res.status, 503)
  assert.deepEqual(await res.json(), { status: "unhealthy" })
})

test("another path or method is the 404 envelope", async (t) => {
  const { url } = await serve(t)
  for (const [method, path] of [
    ["GET", "/nope"],
    ["POST", "/health/live"],
    ["DELETE", "/metrics"]
  ] as const) {
    const res = await fetch(`${url}${path}`, { method, headers: { "x-request-id": "r1" } })
    assert.equal(res.status, 404, `${method} ${path}`)
    assert.deepEqual(await res.json(), {
      error: {
        type: "invalid_request_error",
        code: "NOT_FOUND",
        message: "Resource not found.",
        request_id: "r1",
        details: { resource: "resource", id: null }
      }
    })
  }
})
