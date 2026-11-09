/**
 * The API's schemas. Fastify validates each request against its route's (AJV, no type
 * coercion, a body's unknown keys refused), and @fastify/swagger turns them into the OpenAPI
 * document. A failure is a 422 listing each wrong field with its sentence (validation.ts):
 * the route's `Messages`, else the fallback one.
 */
import { type Static, Type } from "typebox"

/** A field's sentences by the AJV keyword that failed, `*` for any: path → keyword → sentence. */
export type Messages = Readonly<Record<string, Readonly<Record<string, string>>>>

/** Plat5 ids, and this API's, are ULIDs in lowercase. */
export const LOWERCASE_ULID = "^[0-7][0-9a-hjkmnp-tv-z]{25}$"

const STATUS = "Status must be todo, in progress, or done."

/** The sentences for a task's body (plat5 docs/reference/error-copy.md). */
export const taskMessages: Messages = {
  title: {
    required: "Title is required.",
    minLength: "Title is required.",
    maxLength: "Title is too long."
  },
  status: { "*": STATUS }
}

/** The sentences for a profile's body. */
export const profileMessages: Messages = {
  bio: { required: "Bio is required.", maxLength: "Bio is too long." }
}

export const taskStatusSchema = Type.Enum(["todo", "in_progress", "done"])

/** Trimmed of white space before it's checked (tasks/routes.ts). AJV counts code points. */
const titleSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  description: "Trimmed of white space, then 1 to 255 characters."
})

const assigneeIdSchema = Type.Union([Type.String({ pattern: LOWERCASE_ULID }), Type.Null()], {
  description: "A member id in the project's tree who can see the project, or null for none."
})

// Authored data: created_by is the member who made it, and stays theirs if they leave
// the tree (plat5 docs/concepts/model.md#where-a-field-goes). assignee_id is a member in
// the same tree, or null.
export const taskSchema = Type.Object({
  id: Type.String(),
  project_id: Type.String(),
  title: Type.String(),
  status: taskStatusSchema,
  assignee_id: Type.Union([Type.String(), Type.Null()]),
  created_by: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String()
})

/** A create's body. Without a status, a task is `todo`; without an assignee, it has none. */
export const taskCreateSchema = Type.Object(
  {
    title: titleSchema,
    status: Type.Optional(taskStatusSchema),
    assignee_id: Type.Optional(assigneeIdSchema)
  },
  { additionalProperties: false }
)

/** An update's body. A field absent or null leaves the task's as it is, but for assignee_id: null unassigns. */
export const taskUpdateSchema = Type.Object(
  {
    title: Type.Optional(Type.Union([titleSchema, Type.Null()])),
    status: Type.Optional(Type.Union([taskStatusSchema, Type.Null()])),
    assignee_id: Type.Optional(assigneeIdSchema)
  },
  { additionalProperties: false }
)

export const taskListSchema = Type.Object({
  tasks: Type.Array(taskSchema),
  has_more: Type.Boolean()
})

export const profileSchema = Type.Object({
  user_id: Type.String(),
  bio: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String()
})

// No name here: the person's name is identity's (GET /user), shown in every org.
export const profileUpdateSchema = Type.Object(
  { bio: Type.String({ maxLength: 2000, description: "At most 2000 characters, kept as sent." }) },
  { additionalProperties: false }
)

export const profileParamsSchema = Type.Object({ user_id: Type.String() })
export const projectParamsSchema = Type.Object({ project_id: Type.String() })
export const taskParamsSchema = Type.Object({ project_id: Type.String(), task_id: Type.String() })

/** The Plat5 error envelope (plat5 docs/reference/errors.md), as `ApiError` writes it. */
export const errorSchema = (description: string) =>
  Type.Object(
    {
      error: Type.Object({
        type: Type.String(),
        code: Type.String(),
        message: Type.String(),
        request_id: Type.Union([Type.String(), Type.Null()]),
        details: Type.Unknown()
      })
    },
    { description }
  )

export type Task = Static<typeof taskSchema>
export type TaskStatus = Static<typeof taskStatusSchema>
export type Profile = Static<typeof profileSchema>
