import assert from "node:assert/strict"
import { test } from "node:test"
import { now } from "./clock.js"

test("now drops the fraction's trailing zeros, as Go's RFC3339Nano", () => {
  for (const [iso, want] of [
    ["2026-10-29T18:48:03.199Z", "2026-10-29T18:48:03.199Z"],
    ["2026-10-29T18:48:03.190Z", "2026-10-29T18:48:03.19Z"],
    ["2026-10-29T18:48:10.500Z", "2026-10-29T18:48:10.5Z"],
    ["2026-10-29T18:48:10.000Z", "2026-10-29T18:48:10Z"],
    ["2026-10-29T18:00:00.000Z", "2026-10-29T18:00:00Z"]
  ]) {
    assert.equal(now(new Date(iso!)), want)
  }
})
