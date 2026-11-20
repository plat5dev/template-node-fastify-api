import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest
} from "fastify"
import type { AccessClient } from "./access.ts"
import {
  ApiError,
  internalError,
  invalidRequest,
  notFound,
  validationFailed
} from "./errors.ts"
import { profileRoutes, type ProfilesStore } from "./profiles.ts"
import { taskRoutes, type TasksStore } from "./tasks.ts"
import { observabilityPlugin, type RequestObserver } from "./telemetry.ts"

export type AppDeps = {
  tasks: TasksStore
  profiles: ProfilesStore
  access: AccessClient
  assigneePermission?: string
  version: string
  observeRequest?: RequestObserver
  /** Optional Pino output stream (used by tests to capture structured JSON logs). */
  logStream?: { write(msg: string): void }
}

const toApiError = (err: FastifyError): ApiError => {
  if (err instanceof ApiError) return err
  if (err.validation) return validationFailed(err.validation, err.validationContext)
  const status = err.statusCode ?? 500
  return status >= 400 && status < 500 ? invalidRequest() : internalError()
}

const sendError = (reply: FastifyReply, answer: ApiError) =>
  reply.status(answer.status).send(answer.envelope(reply.request.id || null))

export const buildApp = async (deps: AppDeps) => {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      messageKey: "message",
      base: undefined,
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label })
      },
      ...(deps.logStream ? { stream: deps.logStream } : {})
    },
    logController: new Fastify.LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "request_id"
    }),
    requestIdHeader: "x-request-id",
    genReqId: () => "",
    childLoggerFactory(logger, bindings, opts) {
      return bindings.request_id ? logger.child(bindings, opts) : logger
    },
    routerOptions: { ignoreTrailingSlash: true },
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: true } },
    frameworkErrors: (_err, _req, reply) => sendError(reply, invalidRequest())
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.removeContentTypeParser("text/plain")

  await app.register(observabilityPlugin, { observeRequest: deps.observeRequest })

  app.addHook("preValidation", async (req: FastifyRequest) => {
    if (req.routeOptions.schema?.body !== undefined && req.body === undefined) {
      throw invalidRequest()
    }
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const answer = toApiError(err)
    req.failure = { answer, cause: answer === err ? undefined : err }
    if (answer.status >= 500) req.span?.recordException(err)
    return sendError(reply, answer)
  })

  app.setNotFoundHandler((_req, reply) => sendError(reply, notFound("resource", null)))

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Plat5 API",
        description: "Reference Node + Fastify + TypeBox business service for Plat5",
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
