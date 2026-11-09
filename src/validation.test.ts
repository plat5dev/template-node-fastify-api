import assert from "node:assert/strict"
import { test } from "node:test"
import { validationFailed } from "./validation.ts"

const error = (keyword: string, instancePath: string, params: Record<string, unknown> = {}) => ({
  keyword,
  instancePath,
  schemaPath: "",
  params,
  message: "AJV's words, never shown"
})

test("paths: nested keys dotted, array items indexed, the body itself is body", () => {
  const got = validationFailed(
    [
      error("type", "/address/street"),
      error("type", "/tags/0/name"),
      error("type", ""),
      error("required", "/address", { missingProperty: "zip" })
    ],
    "querystring",
    {}
  )
  assert.deepEqual(
    (got.details as { fields: { path: string }[] }).fields.map((f) => f.path),
    ["address.street", "tags[0].name", "body", "address.zip"]
  )
})

test("unknown keys, at their paths, and only them", () => {
  const got = validationFailed(
    [
      error("additionalProperties", "/address", { additionalProperty: "Street" }),
      error("type", "/title")
    ],
    "body",
    {}
  )
  assert.deepEqual(got.details, {
    fields: [{ path: "address.Street", message: "address.Street isn't a field." }]
  })
  assert.equal(got.message, "address.Street isn't a field.")
})

test("a field's sentence by the keyword that failed, else its any, else the fallback; a field once", () => {
  const messages = { title: { minLength: "Title is required." }, status: { "*": "Status!" } }
  const got = validationFailed(
    [
      error("minLength", "/title"),
      error("type", "/title"),
      error("enum", "/status"),
      error("pattern", "/assignee_id")
    ],
    "body",
    { assignee_id: "x", status: 1, title: "" },
    messages
  )
  assert.deepEqual(got.details, {
    fields: [
      { path: "assignee_id", message: "That doesn't look right." },
      { path: "status", message: "Status!" },
      { path: "title", message: "Title is required." }
    ]
  })
})
