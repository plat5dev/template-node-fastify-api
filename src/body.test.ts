import assert from "node:assert/strict"
import { test } from "node:test"
import { charLength, isJson, isLowercaseUlid, trimSpace } from "./body.js"

test("isJson: application/json or application/…+json", () => {
  for (const value of ["application/json", " Application/JSON ; charset=utf-8", "application/merge-patch+json", "application/+json"]) {
    assert.equal(isJson(value), true, value)
  }
  for (const value of [undefined, "", "text/json", "application/jsonx", "text/plain+json", "json"]) {
    assert.equal(isJson(value), false, String(value))
  }
})

test("trimSpace is Go's strings.TrimSpace", () => {
  assert.equal(trimSpace("\u0085   a b　\t"), "a b")
  assert.equal(trimSpace("﻿a"), "﻿a")
})

test("charLength counts code points", () => {
  assert.equal(charLength("é😀a"), 3)
})

test("isLowercaseUlid is Go's ulid.ParseStrict, lowercase", () => {
  assert.equal(isLowercaseUlid("01jd8x3k7q0000000000000000"), true)
  assert.equal(isLowercaseUlid("7zzzzzzzzzzzzzzzzzzzzzzzzz"), true)
  for (const id of ["01JD8X3K7Q0000000000000000", "8zzzzzzzzzzzzzzzzzzzzzzzzz", "01jd8x3k7q000000000000000u", "01jd8x3k7q000000000000000"]) {
    assert.equal(isLowercaseUlid(id), false, id)
  }
})
