import { type Static, Type } from "typebox"

/** Plat5 IDs are lowercase ULIDs. */
export const LOWERCASE_ULID = "^[0-7][0-9a-hjkmnp-tv-z]{25}$"

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

export const listQuerySchema = Type.Object({
  limit: Type.Optional(
    Type.String({
      pattern: "^[0-9]*[1-9][0-9]*$",
      description: `Page size: default ${DEFAULT_LIMIT}, max ${MAX_LIMIT} (values above ${MAX_LIMIT} are clamped).`
    })
  ),
  starting_after: Type.Optional(
    Type.String({
      pattern: LOWERCASE_ULID,
      description: "ID of the last item on the previous page."
    })
  )
})

export type Page = { limit: number; startingAfter: string }

export const pageOf = (query: Static<typeof listQuerySchema>): Page => ({
  limit: Math.min(query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit), MAX_LIMIT),
  startingAfter: query.starting_after ?? ""
})

export const trimPage = <T>(rows: T[], page: Page): { items: T[]; hasMore: boolean } =>
  rows.length > page.limit
    ? { items: rows.slice(0, page.limit), hasMore: true }
    : { items: rows, hasMore: false }

export const taskStatusSchema = Type.Enum(["todo", "in_progress", "done"])

const titleSchema = Type.String({
  minLength: 1,
  pattern: "\\S",
  description: "Trimmed of whitespace; 1 to 255 characters."
})

const assigneeIdSchema = Type.Union([Type.String({ pattern: LOWERCASE_ULID }), Type.Null()], {
  description: "Member ID with access to the project, or null for unassigned."
})

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

export const taskCreateSchema = Type.Object(
  {
    title: titleSchema,
    status: Type.Optional(taskStatusSchema),
    assignee_id: Type.Optional(assigneeIdSchema)
  },
  { additionalProperties: false }
)

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

export const profileUpdateSchema = Type.Object(
  { bio: Type.String({ maxLength: 2000, description: "At most 2000 characters, kept as sent." }) },
  { additionalProperties: false }
)

export const profileParamsSchema = Type.Object({ user_id: Type.String() })
export const projectParamsSchema = Type.Object({ project_id: Type.String() })
export const taskParamsSchema = Type.Object({ project_id: Type.String(), task_id: Type.String() })

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
