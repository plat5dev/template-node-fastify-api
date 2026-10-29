import assert from "node:assert/strict"
import { test } from "node:test"
import {
  anything,
  arrayOf,
  charLength,
  checkKeys,
  isJson,
  isLowercaseUlid,
  object,
  recordOf,
  trimSpace,
  unknownFields
} from "./body.js"
import { ApiError } from "./errors.js"

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

const tag = object({ name: anything })
const shape = object({
  title: anything,
  raw: anything,
  address: object({ street: anything }),
  tags: arrayOf(tag),
  meta: recordOf(anything),
  by_name: recordOf(tag)
})

test("unknownFields: keys match exactly, in the body's order, each once", () => {
  for (const [json, paths] of [
    [`{"title":"T","raw":{"Anything":[{"x":1}]},"address":{"street":"Main"},"tags":[{"name":"a"},{"name":"b"}],"meta":{"Free":{"Form":1}},"by_name":{"k":{"name":"c"}}}`, []],
    [`null`, []],
    [`[{"x":1}]`, []],
    [`{"Title":"T"}`, ["Title"]],
    [`{"title":"T","extra":1}`, ["extra"]],
    [`{"b":1,"title":"T","a":2}`, ["b", "a"]],
    // Integer keys keep their place, which JSON.parse's objects don't.
    [`{"b":1,"2":2,"1":3}`, ["b", "2", "1"]],
    [`{"address":{"Street":"Main"}}`, ["address.Street"]],
    [`{"tags":[{"name":"a"},{"Name":"b","x":1}]}`, ["tags[1].Name", "tags[1].x"]],
    [`{"by_name":{"k":{"nope":1}}}`, ["by_name.k.nope"]],
    [`{"Title":5,"zzz":true}`, ["Title", "zzz"]],
    [`{"x":1,"title":"T","y":2,"x":3}`, ["x", "y"]],
    [` { "a b" : "}\\\"", "t\\u0069tle" : [ 1 , { } ] , "\\ud800" : 1 } `, ["a b", "\ufffd"]],
    // A value of the wrong shape isn't walked: its type is checked after the keys.
    [`{"address":[{"x":1}],"tags":{"x":1}}`, []]
  ] as const) {
    assert.deepEqual(unknownFields(json, shape), paths, json)
  }
})

test("checkKeys: a 422 listing each unknown field, the first one's sentence the message", () => {
  assert.doesNotThrow(() => checkKeys(`{"title":"T"}`, shape))
  assert.throws(
    () => checkKeys(`{"Title":"T","address":{"Street":1}}`, shape),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.status, 422)
      assert.equal(err.code, "VALIDATION_ERROR")
      assert.equal(err.message, "Title isn't a field.")
      assert.deepEqual(err.details, {
        fields: [
          { path: "Title", message: "Title isn't a field." },
          { path: "address.Street", message: "address.Street isn't a field." }
        ]
      })
      return true
    }
  )
})
