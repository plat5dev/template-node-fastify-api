import assert from "node:assert/strict"
import { test } from "node:test"
import { validationFailed } from "./errors.ts"

const ajvError = (
  keyword: string,
  instancePath: string,
  message: string,
  params: Record<string, unknown> = {}
) => ({
  keyword,
  instancePath,
  schemaPath: "",
  params,
  message
})

test("maps nested paths, array indices, required, additionalProperties, and deduplicates", () => {
  const err = validationFailed(
    [
      ajvError("type", "/address/street", "must be string"),
      ajvError("type", "/tags/0/name", "must be string"),
      ajvError("required", "/address", "must have required property 'zip'", { missingProperty: "zip" }),
      ajvError("additionalProperties", "/address", "must NOT have additional properties", {
        additionalProperty: "Street"
      }),
      ajvError("minLength", "/address/street", "duplicate path ignored")
    ],
    "body"
  )

  assert.equal(err.status, 422)
  assert.equal(err.code, "VALIDATION_ERROR")
  assert.deepEqual(err.details, {
    fields: [
      { path: "address.street", message: "must be string" },
      { path: "tags[0].name", message: "must be string" },
      { path: "address.zip", message: "must have required property 'zip'" },
      { path: "address.Street", message: "must NOT have additional property 'Street'" }
    ]
  })
  assert.equal(err.message, "must be string")
})

test("root-level errors use the failing request part instead of hardcoding body", () => {
  for (const part of ["body", "querystring", "params"] as const) {
    const err = validationFailed([ajvError("type", "", "must be object")], part)
    assert.deepEqual(err.details, { fields: [{ path: part, message: "must be object" }] })
  }
})
