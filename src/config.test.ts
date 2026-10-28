import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "./config.js"

const setPermission = (value: string | undefined) => {
  if (value === undefined) delete process.env.TASK_ASSIGNEE_PERMISSION
  else process.env.TASK_ASSIGNEE_PERMISSION = value
}

const before = process.env.TASK_ASSIGNEE_PERMISSION
test.afterEach(() => setPermission(before))

test("TASK_ASSIGNEE_PERMISSION unset or empty: the API won't start", () => {
  for (const value of [undefined, "", "  "]) {
    setPermission(value)
    assert.throws(loadConfig, {
      message:
        "TASK_ASSIGNEE_PERMISSION is unset or empty: set it to the permission an assignee needs on the task's project (the starter's is project:read)"
    })
  }
})

test("TASK_ASSIGNEE_PERMISSION names the assignee's permission", () => {
  setPermission("tasks:assignable")
  assert.equal(loadConfig().taskAssigneePermission, "tasks:assignable")
})
