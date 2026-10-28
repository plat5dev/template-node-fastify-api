import { propagation, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api"
import { core } from "@opentelemetry/sdk-node"
import assert from "node:assert/strict"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { AccessClient, type Question } from "./access.js"

// initTelemetry's propagator when nothing exports traces.
propagation.setGlobalPropagator(new core.W3CTraceContextPropagator())

const member = "01jd8x3k7q00000000000000mm"
const project = "01jd8x3k7q00000000000000pp"
const question: Question = {
  memberId: member,
  kind: "project",
  nodeId: project,
  permission: "project:read"
}

/** Identity, answering every evaluation with `status` and `body`, keeping what it got. */
const serveIdentity = async (t: TestContext, status: number, body: string) => {
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
  test(`evaluate asks identity and answers ${decision}`, async (t) => {
    const identity = await serveIdentity(t, 200, JSON.stringify({ decision }))
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "01000000000000000000000000000000",
      spanId: "0200000000000000",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true
    })

    const got = await new AccessClient(identity.url).evaluate(parent, "req-1", question)
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
  ["not 200", 500, `{"decision":true}`],
  ["no decision", 200, `{}`],
  ["decision not a boolean", 200, `{"decision":"true"}`],
  ["not JSON", 200, `yes`]
] as const) {
  test(`no answer is an error: ${name}`, async (t) => {
    const logs = t.mock.method(console, "log", () => {})
    const identity = await serveIdentity(t, status, body)
    await assert.rejects(
      new AccessClient(identity.url).evaluate(ROOT_CONTEXT, "req-1", question)
    )
    // Logged with the request id.
    const line = JSON.parse(String(logs.mock.calls[0]?.arguments[0]))
    assert.equal(line.message, "access evaluation failed")
    assert.equal(line.request_id, "req-1")
  })
}

test("no answer is an error: identity unreachable or unset", async (t) => {
  t.mock.method(console, "log", () => {})
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
  const { port } = closed.address() as AddressInfo
  await new Promise((resolve) => closed.close(resolve))
  await assert.rejects(
    new AccessClient(`http://127.0.0.1:${port}`).evaluate(ROOT_CONTEXT, "", question)
  )
  await assert.rejects(new AccessClient(undefined).evaluate(ROOT_CONTEXT, "", question), {
    message: "IDENTITY_INTERNAL_URL is unset"
  })
})
