import assert from "node:assert/strict"
import { test } from "node:test"
import { DETAILS_HEADER } from "./audit.ts"
import type { Profile } from "./schemas.ts"
import { assertMalformed, assertValidationPaths, newApp } from "./testing.ts"

const user = "01jd8x3k7q00000000000000u1"
const path = `/users/${user}/profile`

const auditHeader = (res: { headers: Record<string, unknown> }) =>
  res.headers[DETAILS_HEADER.toLowerCase()]

test("GET lazily creates an empty profile (concurrent-safe)", async (t) => {
  const { send } = await newApp(t)
  const [a, b] = await Promise.all([send("GET", path), send("GET", path)])
  assert.equal(a.statusCode, 200)
  assert.equal(b.statusCode, 200)
  const profile = a.json<Profile>()
  assert.deepEqual([profile.user_id, profile.bio], [user, ""])
  assert.equal(profile.created_at, profile.updated_at)
  assert.deepEqual(b.json(), profile)
  assert.equal(auditHeader(a), undefined)
})

test("PUT upserts bio (up to 2000 code points, untrimmed) and emits audit diff", async (t) => {
  const { send } = await newApp(t)

  // New profile: from null -> "".
  let res = await send("PUT", path, JSON.stringify({ bio: "" }))
  assert.equal(res.statusCode, 200)
  assert.equal(auditHeader(res), `{"bio":{"from":null,"to":""}}`)
  const created = res.json<Profile>()

  // Untrimmed bio with HTML chars preserved literally (no Go HTML escaping).
  res = await send("PUT", path, JSON.stringify({ bio: "  <hi>  " }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<Profile>().bio, "  <hi>  ")
  assert.equal(res.json<Profile>().created_at, created.created_at)
  assert.equal(auditHeader(res), `{"bio":{"from":"","to":"  <hi>  "}}`)

  // Unchanged bio emits no audit header.
  res = await send("PUT", path, JSON.stringify({ bio: "  <hi>  " }))
  assert.equal(auditHeader(res), undefined)

  // 2000 multi-byte code points allowed; 2001 rejected.
  assert.equal(
    (await send("PUT", path, JSON.stringify({ bio: "😀".repeat(2000) }))).statusCode,
    200
  )
  assertValidationPaths(
    await send("PUT", path, JSON.stringify({ bio: "😀".repeat(2001) })),
    ["bio"]
  )

  // Profile created via GET has from: "" on first PUT.
  const other = "/users/01jd8x3k7q00000000000000u2/profile"
  await send("GET", other)
  res = await send("PUT", other, `{"bio":"x"}`)
  assert.equal(auditHeader(res), `{"bio":{"from":"","to":"x"}}`)
})

test("PUT validation and malformed bodies", async (t) => {
  const { send } = await newApp(t)
  assertValidationPaths(await send("PUT", path, `{}`), ["bio"])
  assertValidationPaths(await send("PUT", path, `{"bio":null}`), ["bio"])
  assertValidationPaths(await send("PUT", path, `{"bio":5}`), ["bio"])
  assertValidationPaths(await send("PUT", path, `{"bio":"hi","extra":1}`), ["extra"])
  assertValidationPaths(await send("PUT", path, `["hi"]`), ["body"])

  assertMalformed(await send("PUT", path, `{"bio":"hi"}`, { without: "content-type" }))
  assertMalformed(await send("PUT", path, `{"bio":"hi"}`, { headers: { "content-type": "text/plain" } }))
  assertMalformed(await send("PUT", path, `{`))
})
