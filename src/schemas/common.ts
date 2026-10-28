import { type Static, Type } from "@sinclair/typebox"

const nonEmptyString = (maxLength = 255) =>
  Type.String({ minLength: 1, maxLength, pattern: "\\S" })

// A string or null: `nullable` (OpenAPI's, which AJV reads), not a union with null.
// Fastify's AJV coerces types, and in a union "" would pass as null.
const nullableString = (options: { pattern?: string; description?: string } = {}) =>
  Type.Unsafe<string | null>({ type: "string", nullable: true, ...options })

/** Plat5 ids, and this API's, are ULIDs in lowercase. */
const LOWERCASE_ULID = "^[0-7][0-9a-hjkmnp-tv-z]{25}$"

export const profileSchema = Type.Object({
  user_id: Type.String(),
  bio: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String()
})

// No name here: the person's name is identity's (GET /user), shown in every org.
export const profileUpdateSchema = Type.Object({
  bio: Type.String({ maxLength: 2000 })
})

export const taskStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("in_progress"),
  Type.Literal("done")
])

// Authored data: created_by is the member who made it, and stays theirs if they leave
// the tree (plat5 docs/concepts/model.md#where-a-field-goes). assignee_id is a member in
// the same tree, or null.
export const taskSchema = Type.Object({
  id: Type.String(),
  environment_id: Type.String(),
  title: Type.String(),
  status: taskStatusSchema,
  assignee_id: nullableString(),
  created_by: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String()
})

const assigneeIdSchema = nullableString({
  pattern: LOWERCASE_ULID,
  description:
    "A member id in the environment's tree who can see its project, or null for none."
})

export const taskCreateSchema = Type.Object({
  title: nonEmptyString(),
  status: Type.Optional(taskStatusSchema),
  assignee_id: Type.Optional(assigneeIdSchema)
})

// assignee_id absent leaves the task's as it is.
export const taskUpdateSchema = Type.Object({
  title: Type.Optional(nonEmptyString()),
  status: Type.Optional(taskStatusSchema),
  assignee_id: Type.Optional(assigneeIdSchema)
})

export const profileParamsSchema = Type.Object({ user_id: Type.String() })

export const environmentParamsSchema = Type.Object({ environment_id: Type.String() })

export const taskParamsSchema = Type.Object({
  environment_id: Type.String(),
  task_id: Type.String()
})

export const taskListSchema = Type.Object({
  tasks: Type.Array(taskSchema),
  has_more: Type.Boolean()
})

/** The Plat5 error envelope (plat5 docs/reference/errors.md), as `ApiError` writes it. */
export const errorSchema = (description: string) =>
  Type.Object(
    {
      error: Type.Object({
        type: Type.String(),
        code: Type.String(),
        message: Type.String(),
        request_id: nullableString(),
        details: Type.Unknown()
      })
    },
    { description }
  )

export type Profile = Static<typeof profileSchema>
export type Task = Static<typeof taskSchema>
export type TaskStatus = Static<typeof taskStatusSchema>
