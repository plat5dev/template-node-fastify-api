import Fastify from "fastify"
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import type { AccessClient } from "./access.js"
import { MAX_BODY_BYTES } from "./errors.js"
import { registerObservability, sendError } from "./middleware/observability.js"
import type { ProfilesStore } from "./profiles/store.js"
import { registerProfileRoutes } from "./profiles/routes.js"
import type { TasksStore } from "./tasks/store.js"
import { registerTaskRoutes } from "./tasks/routes.js"
import type { App } from "./types.js"

export type AppDeps = {
  tasks: TasksStore
  profiles: ProfilesStore
  access: AccessClient
  /** The permission a task's assignee needs on its project. */
  assigneePermission: string
  /** The OpenAPI at /docs, with this version. Unset: no /docs. */
  docsVersion?: string
}

/**
 * The public API. Bodies are read by the routes that take one (body.ts): every body is
 * kept as raw bytes up to 1 MiB, and schemas describe the API for the OpenAPI but don't
 * validate, so every answer is the API's own, in the Plat5 envelope.
 */
export const buildApp = async (deps: AppDeps): Promise<App> => {
  const app = Fastify({
    logger: false,
    // No CORS: the gateway owns it (plat5 docs/guides/write-a-service.md)
    trustProxy: true,
    bodyLimit: MAX_BODY_BYTES,
    routerOptions: { ignoreTrailingSlash: true },
    // A URL Fastify can't decode: the envelope, never Fastify's text.
    frameworkErrors: (err, req, reply) => sendError(err, req, reply)
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.removeAllContentTypeParsers()
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body))
  app.setValidatorCompiler(() => () => true)

  registerObservability(app)

  if (deps.docsVersion !== undefined) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Plat5 API",
          description: "Reference Node + Fastify business service for Plat5",
          version: deps.docsVersion
        }
      }
    })
    await app.register(swaggerUi, { routePrefix: "/docs" })
  }

  registerProfileRoutes(app, deps.profiles)
  registerTaskRoutes(app, deps.tasks, deps.access, deps.assigneePermission)
  await app.ready()
  return app
}
