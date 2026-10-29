import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { AccessClient } from "../access.js"
import { buildApp } from "../app.js"
import { DETAILS_HEADER } from "../audit.js"
import { connect, migrate } from "../db.js"
import type { Profile } from "../schemas/common.js"
import { TasksStore } from "../tasks/store.js"
import { ProfilesStore } from "./store.js"

const user = "01jd8x3k7q00000000000000u1"
const path = `/users/${user}/profile`

const newApp = async (t: TestContext) => {
  t.mock.method(console, "log", () => {})
  const db = connect(":memory:")
  migrate(db)
  t.after(() => db.close())
  const app = await buildApp({
    tasks: new TasksStore(db),
    profiles: new ProfilesStore(db),
    access: new AccessClient(undefined),
    assigneePermission: "project:read"
  })
  t.after(() => app.close())
  /** PUTs `body` as JSON, or with `contentType`, or with none when it's null. */
  const put = (body: string, contentType: string | null = "application/json") =>
    app.inject({
      method: "PUT",
      url: path,
      payload: body,
      headers: contentType === null ? {} : { "content-type": contentType }
    })
  return { app, put }
}

const assertField = (
  res: { statusCode: number; json: <T>() => T },
  field: string,
  message: string,
  label = ""
) => {
  assert.equal(res.statusCode, 422, label)
  const { error } = res.json<{
    error: { code: string; message: string; details: { fields: unknown } }
  }>()
  assert.equal(error.code, "VALIDATION_ERROR", label)
  assert.equal(error.message, message, label)
  assert.deepEqual(error.details.fields, [{ path: field, message }], label)
}

const details = (res: { headers: Record<string, unknown> }) => res.headers[DETAILS_HEADER.toLowerCase()]

test("GET makes the profile", async (t) => {
  const { app } = await newApp(t)
  const res = await app.inject({ method: "GET", url: path })
  assert.equal(res.statusCode, 200)
  const profile = res.json<Profile>()
  assert.equal(profile.user_id, user)
  assert.equal(profile.bio, "")
  assert.equal(details(res), undefined)
})

test("PUT: bio required, not trimmed, at most 2000 characters", async (t) => {
  const { put } = await newApp(t)
  for (const body of [`{}`, `{"bio":null}`, `null`]) {
    assertField(await put(body), "bio", "Bio is required.", body)
  }
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

test("PUT: a body not sent as JSON, or not of the right shape, is a 422 at body", async (t) => {
  const { put, app } = await newApp(t)
  const fallback = "That doesn't look right."
  for (const [body, contentType] of [
    [`{"bio":"hi"}`, null],
    [`{"bio":"hi"}`, "text/plain"],
    ["", null],
    ["", "application/json"],
    ["{", "application/json"],
    [`{"bio":5}`, "application/json"],
    [`["hi"]`, "application/json"]
  ] as const) {
    assertField(await put(body, contentType), "body", fallback, `${contentType} ${body}`)
  }
  // Nothing written.
  const res = await app.inject({ method: "GET", url: path })
  assert.equal(res.json<Profile>().bio, "")
})

test("PUT: keys match exactly: an unknown field is a 422 naming each", async (t) => {
  const { put, app } = await newApp(t)
  for (const [body, paths] of [
    [`{"Bio":"hi"}`, ["Bio"]],
    [`{"bio":"hi","name":"x"}`, ["name"]],
    // Before any value: the type and the length are checked once the keys are right.
    [`{"BIO":5,"bio":${JSON.stringify("x".repeat(2001))}}`, ["BIO"]]
  ] as const) {
    const res = await put(body)
    assert.equal(res.statusCode, 422, body)
    const { error } = res.json<{
      error: { code: string; message: string; details: { fields: unknown } }
    }>()
    assert.equal(error.code, "VALIDATION_ERROR", body)
    assert.equal(error.message, `${paths[0]} isn't a field.`, body)
    assert.deepEqual(
      error.details.fields,
      paths.map((path) => ({ path, message: `${path} isn't a field.` })),
      body
    )
  }
  // Nothing written.
  const res = await app.inject({ method: "GET", url: path })
  assert.equal(res.json<Profile>().bio, "")
  assert.equal((await put(`{"bio":"hi"}`)).statusCode, 200)
})

test("PUT: audit details", async (t) => {
  const { put } = await newApp(t)
  let res = await put(`{"bio":"é"}`)
  assert.equal(res.statusCode, 200)
  assert.equal(details(res), `{"bio":{"from":null,"to":"\\u00e9"}}`)
  res = await put(`{"bio":"é"}`)
  assert.equal(details(res), undefined, "unchanged")
  res = await put(`{"bio":"new"}`)
  assert.equal(details(res), `{"bio":{"from":"\\u00e9","to":"new"}}`)
})
