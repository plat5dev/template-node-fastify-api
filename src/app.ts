import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify"
import type { AccessClient } from "./access.ts"
import { ApiError, internalError, invalidRequest, notFound } from "./errors.ts"
import { registerObservability, requestIdOf } from "./observability.ts"
import { profileRoutes } from "./profiles/routes.ts"
import type { ProfilesStore } from "./profiles/store.ts"
import type { Messages } from "./schemas.ts"
import { taskRoutes } from "./tasks/routes.ts"
import type { TasksStore } from "./tasks/store.ts"
import { validationFailed } from "./validation.ts"

declare module "fastify" {
  interface FastifyContextConfig {
    /** The sentences for the route's fields, when its request doesn't match its schema. */
    messages?: Messages
  }
}

export type AppDeps = {
  tasks: TasksStore
  profiles: ProfilesStore
  access: AccessClient
  /** The permission a task's assignee needs on its project. */
  assigneePermission: string
  /** The API's version, in its OpenAPI document. */
  version: string
}

/**
 * Any error as the API's (plat5 docs/reference/errors.md): its own as they are; a request
 * that doesn't match its route's schema a 422; one Fastify couldn't read (a body not sent as
 * `application/json`, empty, or not JSON) a 400; anything else the fallback 500. Never a
 * framework's text in the message.
 */
const toApiError = (err: FastifyError, req: FastifyRequest): ApiError => {
  if (err instanceof ApiError) return err
  if (err.validation) {
    return validationFailed(
      err.validation,
      err.validationContext,
      req.body,
      req.routeOptions.config.messages
    )
  }
  const status = err.statusCode ?? 500
  return status >= 400 && status < 500 ? invalidRequest() : internalError()
}

const send = (reply: FastifyReply, answer: ApiError) =>
  reply.status(answer.status).send(answer.envelope(requestIdOf(reply.request)))

/**
 * The public API. A body is JSON, sent as `application/json` (any parameters), and checked
 * against its route's schema: AJV without type coercion, a body's unknown keys refused, every
 * wrong field reported. Every answer is the API's own, in the Plat5 envelope.
 */
export const buildApp = async (deps: AppDeps) => {
  const app = Fastify({
    logger: false,
    routerOptions: { ignoreTrailingSlash: true },
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: true } },
    // A URL Fastify can't decode: the envelope, never Fastify's text.
    frameworkErrors: (_err, _req, reply) => send(reply, invalidRequest())
  }).withTypeProvider<TypeBoxTypeProvider>()

  // JSON is the only body: anything else is Fastify's 415, answered as a 400.
  app.removeContentTypeParser("text/plain")

  registerObservability(app)

  // A route that takes a body answers 400 when none is sent.
  app.addHook("preValidation", async (req) => {
    if (req.routeOptions.schema?.body !== undefined && req.body === undefined)
      throw invalidRequest()
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const answer = toApiError(err, req)
    req.failure = { answer, cause: answer === err ? undefined : err }
    if (answer.status >= 500) req.span?.recordException(err)
    return send(reply, answer)
  })

  // An unknown route, or a known path in a method it doesn't serve: the same 404 either way.
  app.setNotFoundHandler((_req, reply) => send(reply, notFound("resource", null)))

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Plat5 API",
        description: "Reference Node + Fastify business service for Plat5",
        version: deps.version
      }
    }
  })
  await app.register(swaggerUi, { routePrefix: "/docs" })
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger())

  await app.register(profileRoutes, { store: deps.profiles })
  await app.register(taskRoutes, {
    store: deps.tasks,
    access: deps.access,
    assigneePermission: deps.assigneePermission
  })
  await app.ready()
  return app
}

export type App = Awaited<ReturnType<typeof buildApp>>
