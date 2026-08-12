import { type Static, Type } from "@sinclair/typebox"

const nonEmptyString = (maxLength = 255) =>
  Type.String({ minLength: 1, maxLength, pattern: "\\S" })

export const profileSchema = Type.Object({
  user_id: Type.String(),
  display_name: Type.String(),
  bio: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String()
})

export const profileUpdateSchema = Type.Object({
  display_name: nonEmptyString(),
  bio: Type.Optional(Type.String({ maxLength: 2000 }))
})

export const projectSchema = Type.Object({
  id: Type.String(),
  organization_id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  created_by_member_id: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String()
})

export const projectCreateSchema = Type.Object({
  name: nonEmptyString(),
  description: Type.Optional(Type.String({ maxLength: 2000 }))
})

export const projectUpdateSchema = Type.Object({
  name: Type.Optional(nonEmptyString()),
  description: Type.Optional(Type.String({ maxLength: 2000 }))
})

export const taskStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("in_progress"),
  Type.Literal("done")
])

export const taskSchema = Type.Object({
  id: Type.String(),
  organization_id: Type.String(),
  project_id: Type.String(),
  title: Type.String(),
  status: taskStatusSchema,
  created_by_member_id: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String()
})

export const taskCreateSchema = Type.Object({
  title: nonEmptyString(),
  status: Type.Optional(taskStatusSchema)
})

export const taskUpdateSchema = Type.Object({
  title: Type.Optional(nonEmptyString()),
  status: Type.Optional(taskStatusSchema)
})

export const profileParamsSchema = Type.Object({ user_id: Type.String() })

export const organizationParamsSchema = Type.Object({
  organization_id: Type.String()
})

export const projectParamsSchema = Type.Object({
  organization_id: Type.String(),
  project_id: Type.String()
})

export const taskParamsSchema = Type.Object({
  organization_id: Type.String(),
  project_id: Type.String(),
  task_id: Type.String()
})

export const projectListSchema = Type.Object({
  projects: Type.Array(projectSchema)
})

export const taskListSchema = Type.Object({
  tasks: Type.Array(taskSchema)
})

export type Profile = Static<typeof profileSchema>
export type Project = Static<typeof projectSchema>
export type Task = Static<typeof taskSchema>
export type TaskStatus = Static<typeof taskStatusSchema>