import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DETAILS_HEADER } from "../audit.ts"
import type { Profile } from "../schemas.ts"
import { assertField, assertFields, assertMalformed, FALLBACK, newApp } from "../testing.ts"

const user = "01jd8x3k7q00000000000000u1"
const path = `/users/${user}/profile`

const setup = async (t: TestContext) => {
  const { send } = await newApp(t)
  /** PUTs `body` as JSON, or with `contentType`, or with none when it's null. */
  const put = (body: string, contentType: string | null = "application/json") =>
    send(
      "PUT",
      path,
      body,
      contentType === null
        ? { without: "content-type" }
        : { headers: { "content-type": contentType } }
    )
  const bio = async () => (await send("GET", path)).json<Profile>().bio
  return { send, put, bio }
}

const details = (res: { headers: Record<string, unknown> }) =>
  res.headers[DETAILS_HEADER.toLowerCase()]

test("GET makes an empty profile on the first call, and answers the same one after", async (t) => {
  const { send } = await setup(t)
  const first = await send("GET", path)
  assert.equal(first.statusCode, 200)
  const profile = first.json<Profile>()
  assert.deepEqual([profile.user_id, profile.bio], [user, ""])
  assert.equal(profile.created_at, profile.updated_at)
  assert.equal(details(first), undefined)
  // Two first reads at once make one profile.
  const [a, b] = await Promise.all([send("GET", path), send("GET", path)])
  assert.deepEqual(a!.json(), profile)
  assert.deepEqual(b!.json(), profile)
})

test("PUT: bio required, not trimmed, at most 2000 characters", async (t) => {
  const { put } = await setup(t)
  assertField(await put(`{}`), "bio", "Bio is required.")
  assertField(await put(`{"bio":null}`), "bio", FALLBACK)
  assertField(await put(JSON.stringify({ bio: "é".repeat(2001) })), "bio", "Bio is too long.")
  assertField(await put(JSON.stringify({ bio: "😀".repeat(2001) })), "bio", "Bio is too long.")
  let res = await put(JSON.stringify({ bio: "😀".repeat(2000) }))
  assert.equal(res.statusCode, 200)
  res = await put(JSON.stringify({ bio: "  hi  " }))
  assert.equal(res.json<Profile>().bio, "  hi  ")
  res = await put(JSON.stringify({ bio: "" }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<Profile>().bio, "")
})

test("PUT: a body not sent as JSON, empty, or not JSON is a 400; of the wrong shape, a 422", async (t) => {
  const { put, bio } = await setup(t)
  for (const [body, contentType] of [
    [`{"bio":"hi"}`, null],
    [`{"bio":"hi"}`, "text/plain"],
    ["", null],
    ["", "application/json"],
    ["{", "application/json"]
  ] as const) {
    assertMalformed(await put(body, contentType), `${contentType} ${body}`)
  }
  assertField(await put(`{"bio":5}`), "bio", FALLBACK)
  for (const body of [`["hi"]`, `null`, `"hi"`])
    assertField(await put(body), "body", FALLBACK, body)
  // Nothing was written: the profile is still new.
  assert.equal(await bio(), "")
})

test("PUT: keys match exactly: an unknown field is a 422 naming each", async (t) => {
  const { put, bio } = await setup(t)
  for (const [body, paths] of [
    [`{"Bio":"hi"}`, ["Bio"]],
    [`{"bio":"hi","name":"x"}`, ["name"]],
    // Before any value: the type and the length are checked once the keys are right.
    [`{"BIO":5,"bio":${JSON.stringify("x".repeat(2001))}}`, ["BIO"]]
  ] as const) {
    const fields = paths.map((path) => ({ path, message: `${path} isn't a field.` }))
    assertFields(await put(body), fields, body)
  }
  assert.equal(await bio(), "")
  assert.equal((await put(`{"bio":"hi"}`)).statusCode, 200)
})

test("PUT is 200 whether the profile is new or not, with the change audited", async (t) => {
  const { put, send } = await setup(t)
  let res = await put(`{"bio":""}`)
  assert.equal(res.statusCode, 200)
  assert.equal(details(res), `{"bio":{"from":null,"to":""}}`)
  const created = res.json<Profile>()
  res = await put(`{"bio":"<hi>"}`)
  assert.equal(details(res), `{"bio":{"from":"","to":"\\u003chi\\u003e"}}`)
  assert.equal(res.json<Profile>().created_at, created.created_at)
  res = await put(`{"bio":"<hi>"}`)
  assert.equal(details(res), undefined, "unchanged")
  // A profile made by a GET is not new to a PUT.
  const other = "/users/01jd8x3k7q00000000000000u2/profile"
  await send("GET", other)
  res = await send("PUT", other, `{"bio":"x"}`)
  assert.equal(details(res), `{"bio":{"from":"","to":"x"}}`)
})
