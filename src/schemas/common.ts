import { z } from "zod"

export const profileSchema = z.object({
  user_id: z.string(),
  display_name: z.string(),
  bio: z.string(),
  created_at: z.string(),
  updated_at: z.string()
})

export const profileUpdateSchema = z.object({
  display_name: z.string().trim().min(1).max(255),
  bio: z.string().max(2000).optional()
})

export const projectSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  description: z.string(),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string()
})

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional()
})

export const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(2000).optional()
})

export const taskStatusSchema = z.enum(["todo", "in_progress", "done"])

export const taskSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string()
})

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(255),
  status: taskStatusSchema.optional()
})

export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  status: taskStatusSchema.optional()
})

export type Profile = z.infer<typeof profileSchema>
export type Project = z.infer<typeof projectSchema>
export type Task = z.infer<typeof taskSchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
