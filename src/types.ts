import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

export type App = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>