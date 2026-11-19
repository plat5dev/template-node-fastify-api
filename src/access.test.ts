import { context, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api"
import assert from "node:assert/strict"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { accessClient, type AccessQuestion } from "./access.ts"
import { memoryLogger } from "./testing.ts"

const member = "01jd8x3k7q00000000000000mm"
const project = "01jd8x3k7q00000000000000pp"
const question: AccessQuestion = {
  memberId: member,
  kind: "project",
  nodeId: project,
  permission: "project:read"
}

const serveEval = async (t: TestContext, status: number, body: string) => {
  const got: { headers?: IncomingHttpHeaders; body?: unknown } = {}
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/access/v1/evaluation") {
      return res.writeHead(404).end()
    }
    let sent = ""
    for await (const chunk of req) sent += chunk
    got.headers = req.headers
    got.body = JSON.parse(sent)
    res.writeHead(status, { "content-type": "application/json" }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, got }
}

for (const decision of [true, false]) {
  test(`evaluate sends active traceparent, X-Request-ID, and strips trailing slash (${decision})`, async (t) => {
    const identity = await serveEval(t, 200, JSON.stringify({ decision }))
    const activeCtx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "01000000000000000000000000000000",
      spanId: "0200000000000000",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true
    })

    const got = await context.with(activeCtx, () =>
      accessClient(`${identity.url}/`).evaluate(question, { requestId: "req-1" })
    )
    assert.equal(got, decision)
    assert.deepEqual(identity.got.body, {
      subject: { type: "member", id: member },
      resource: { type: "project", id: project },
      action: { name: "project:read" }
    })
    assert.equal(identity.got.headers?.["x-request-id"], "req-1")
    assert.equal(
      identity.got.headers?.traceparent,
      "00-01000000000000000000000000000000-0200000000000000-01"
    )
  })
}

for (const [name, status, body] of [
  ["503 unavailable", 503, `{"error":{"code":"SERVICE_UNAVAILABLE"}}`],
  ["500 error", 500, `{"decision":true}`],
  ["400 bad request", 400, `{"error":{"code":"INVALID_REQUEST"}}`],
  ["missing decision", 200, `{}`],
  ["non-boolean decision", 200, `{"decision":"true"}`],
  ["invalid JSON", 200, `yes`]
] as const) {
  test(`fail-closed on ${name}`, async (t) => {
    const { log, entries } = memoryLogger()
    const identity = await serveEval(t, status, body)
    await assert.rejects(accessClient(identity.url).evaluate(question, { requestId: "req-1", log }))
    assert.equal(entries[0]?.message, "access evaluation failed")
    assert.equal(entries[0]?.request_id, "req-1")
  })
}

test("fail-closed when identity is unreachable or unset; omits empty request id", async (t) => {
  const { log } = memoryLogger()
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
  const { port } = closed.address() as AddressInfo
  await new Promise((resolve) => closed.close(resolve))

  await assert.rejects(accessClient(`http://127.0.0.1:${port}`).evaluate(question, { log }))
  await assert.rejects(accessClient(undefined).evaluate(question, { log }), {
    message: "IDENTITY_INTERNAL_URL is unset"
  })

  const identity = await serveEval(t, 200, `{"decision":true}`)
  assert.equal(await accessClient(identity.url).evaluate(question), true)
  assert.equal(identity.got.headers?.["x-request-id"], undefined)
})
