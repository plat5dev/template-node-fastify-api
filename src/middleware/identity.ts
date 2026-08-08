import type { FastifyRequest } from "fastify"
import { internalError } from "../errors.js"

export const USER_ID_HEADER = "x-user-id"
export const ORGANIZATION_ID_HEADER = "x-organization-id"
export const MEMBERSHIP_ID_HEADER = "x-membership-id"
export const REQUEST_ID_HEADER = "x-request-id"

declare module "fastify" {
  interface FastifyRequest {
    userId?: string
    organizationId?: string
    membershipId?: string
  }
}

export const readHeader = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name]
  if (typeof value === "string" && value.trim() !== "") return value
  if (Array.isArray(value) && value[0] && value[0].trim() !== "") return value[0]
  return undefined
}

export const requestIdOf = (req: FastifyRequest): string | null =>
  readHeader(req, REQUEST_ID_HEADER) ?? null

/** Missing expected gateway identity headers → platform bug (500), never 401. */
export const requireUserHook = async (req: FastifyRequest): Promise<void> => {
  const userId = readHeader(req, USER_ID_HEADER)
  if (!userId) {
    throw internalError("Missing expected identity header X-User-Id")
  }
  req.userId = userId
}

export const requireOrgHook = async (req: FastifyRequest): Promise<void> => {
  const organizationId = readHeader(req, ORGANIZATION_ID_HEADER)
  const membershipId = readHeader(req, MEMBERSHIP_ID_HEADER)
  if (!organizationId || !membershipId) {
    throw internalError(
      "Missing expected identity headers X-Organization-Id and/or X-Membership-Id"
    )
  }
  req.organizationId = organizationId
  req.membershipId = membershipId
}
