/**
 * OpenTelemetry setup (metrics, traces, W3C propagation, AsyncLocalStorage context)
 * and the Fastify observability plugin (server spans, HTTP metrics, Pino access logs).
 */
import {
  context,
  DiagLogLevel,
  type DiagLogger,
  diag,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import {
  defaultResource,
  detectResources,
  resourceAttributesEnvDetector,
  resourceFromAttributes,
  serviceNameEnvDetector
} from "@opentelemetry/resources"
import {
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from "fastify"
import fp from "fastify-plugin"
import type { AppConfig } from "./config.ts"
import type { ApiError } from "./errors.ts"
import type { MetricsHandler } from "./internal.ts"

declare module "fastify" {
  interface FastifyRequest {
    span: Span | null
    failure: { answer: ApiError; cause: unknown } | null
  }
}

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]

const REDACTED_QUERY_KEYS: ReadonlySet<string> = new Set([
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "X-Goog-Signature"
])

const CALLER_HEADERS = [
  ["node_id", "x-plat5-project-id"],
  ["member_id", "x-plat5-member-id"],
  ["user_id", "x-plat5-user-id"]
] as const

export type RequestObserver = (method: string, route: string, status: number, seconds: number) => void

export type Telemetry = {
  metrics: MetricsHandler
  observeRequest: RequestObserver
  setLogger: (logger: FastifyBaseLogger) => void
  shutdown: () => Promise<void>
}

export const headerOf = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

const redactQuery = (query: string): string =>
  query
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=")
      return eq >= 0 && REDACTED_QUERY_KEYS.has(part.slice(0, eq))
        ? `${part.slice(0, eq)}=REDACTED`
        : part
    })
    .join("&")

const extractDiagMessage = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as { message?: unknown } | null
    if (typeof parsed?.message === "string") return parsed.message
  } catch {
    // Not JSON; keep raw message.
  }
  return text
}

/** Formats OpenTelemetry SDK warnings/errors through the Fastify Pino logger. */
export const createDiagLogger = (logger: FastifyBaseLogger): DiagLogger => {
  const emit =
    (level: "error" | "warn", message: string) =>
    (text: string, ...args: unknown[]): void => {
      logger[level]({ error_message: [extractDiagMessage(text), ...args.map(String)].join(" ") }, message)
    }
  return {
    error: emit("error", "telemetry error"),
    warn: emit("warn", "telemetry warning"),
    info: () => {},
    debug: () => {},
    verbose: () => {}
  }
}

export const initTelemetry = (config: Pick<AppConfig, "otlpEndpoint" | "version">): Telemetry => {
  const contextManager = new AsyncLocalStorageContextManager().enable()
  context.setGlobalContextManager(contextManager)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())

  const resource = defaultResource()
    .merge(
      resourceFromAttributes({
        "service.name": "api",
        "service.namespace": "api",
        "service.version": config.version
      })
    )
    .merge(detectResources({ detectors: [resourceAttributesEnvDetector, serviceNameEnvDetector] }))

  const sdkDisabled = process.env.OTEL_SDK_DISABLED?.toLowerCase() === "true"
  const metricsExporter = process.env.OTEL_METRICS_EXPORTER?.toLowerCase()
  const tracesExporter = process.env.OTEL_TRACES_EXPORTER?.toLowerCase()
  const hasMetricsEndpoint =
    config.otlpEndpoint !== undefined || Boolean(process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim())
  const hasTracesEndpoint =
    config.otlpEndpoint !== undefined || Boolean(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim())

  const prometheus = new PrometheusExporter({
    preventServerStart: true,
    withoutScopeInfo: true,
    withoutTargetInfo: true
  })
  const readers: MetricReader[] = [prometheus]
  if (!sdkDisabled && hasMetricsEndpoint && metricsExporter !== "prometheus" && metricsExporter !== "none") {
    readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }))
  }

  const meterProvider = new MeterProvider({ resource, readers })
  const meter = meterProvider.getMeter("api")
  const httpRequests = meter.createCounter("http_requests_total", {
    description: "Total HTTP requests handled by the api service"
  })
  const httpDuration = meter.createHistogram("http_request_duration_seconds", {
    description: "HTTP request latency observed by the api service",
    unit: "s",
    advice: { explicitBucketBoundaries: HTTP_DURATION_BUCKETS }
  })

  const startTime = Date.now() / 1000 - process.uptime()
  meter
    .createObservableGauge("process_resident_memory_bytes", {
      description: "Resident memory size in bytes"
    })
    .addCallback((r) => r.observe(process.memoryUsage.rss()))
  meter
    .createObservableCounter("process_cpu_seconds_total", {
      description: "Total user and system CPU time spent in seconds"
    })
    .addCallback((r) => {
      const usage = process.cpuUsage()
      r.observe((usage.user + usage.system) / 1_000_000)
    })
  meter
    .createObservableGauge("process_start_time_seconds", {
      description: "Start time of the process since unix epoch in seconds"
    })
    .addCallback((r) => r.observe(startTime))

  // Always install a real TracerProvider so spans get local span IDs even when OTLP export is off.
  const spanProcessors =
    !sdkDisabled && hasTracesEndpoint && tracesExporter !== "none"
      ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })]
      : []
  const tracerProvider = new TracerProvider({ resource, spanProcessors })
  trace.setGlobalTracerProvider(tracerProvider)

  return {
    metrics: (req, res) => prometheus.getMetricsRequestHandler(req, res),
    observeRequest: (method, route, status, seconds) => {
      httpRequests.add(1, { method, route, status: String(status) })
      httpDuration.record(seconds, { method, route })
    },
    setLogger: (logger) => {
      diag.setLogger(createDiagLogger(logger), DiagLogLevel.WARN)
    },
    shutdown: async () => {
      await Promise.all([meterProvider.shutdown(), tracerProvider.shutdown()])
    }
  }
}

const observability: FastifyPluginAsync<{ observeRequest?: RequestObserver }> = async (
  app,
  { observeRequest }
) => {
  app.decorateRequest("span", null)
  app.decorateRequest("failure", null)

  // Callback-style onRequest keeps the span active across hooks, body parsing, and route handlers.
  app.addHook("onRequest", (req, reply, done) => {
    const parent = propagation.extract(ROOT_CONTEXT, req.headers)
    const route = req.routeOptions.url
    const at = req.url.indexOf("?")
    const query = at >= 0 ? req.url.slice(at + 1) : ""
    const scheme = (req.raw.socket as { encrypted?: boolean } | null)?.encrypted ? "https" : "http"

    const span = trace.getTracer("api").startSpan(
      route ? `${req.method} ${route}` : req.method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": req.method,
          "url.path": at >= 0 ? req.url.slice(0, at) : req.url,
          "url.scheme": scheme,
          ...(query !== "" ? { "url.query": redactQuery(query) } : {}),
          ...(route ? { "http.route": route } : {}),
          ...(req.id ? { request_id: req.id } : {})
        }
      },
      parent
    )

    req.span = span
    const spanCtx = trace.setSpan(parent, span)
    context.bind(spanCtx, req.raw)
    context.bind(spanCtx, reply.raw)
    context.with(spanCtx, done)
  })

  app.addHook("onRequestAbort", async (req) => {
    req.span?.end()
    req.span = null
  })

  app.addHook("onResponse", async (req, reply) => {
    const status = reply.statusCode
    const route = req.routeOptions.url ?? "unknown"
    const durationMs = Math.round(reply.elapsedTime * 1000) / 1000
    observeRequest?.(req.method, route, status, durationMs / 1000)

    const ids: Record<string, string> = {}
    for (const [field, header] of CALLER_HEADERS) {
      const value = headerOf(req, header)
      if (value !== undefined) ids[field] = value
    }

    const errorType = req.failure?.answer.kind ?? "internal"
    const span = req.span
    if (span) {
      span.setAttribute("http.response.status_code", status)
      for (const [field, value] of Object.entries(ids)) span.setAttribute(`plat5.${field}`, value)
      if (status >= 500) {
        span.setAttribute("error.type", errorType)
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
      span.end()
      req.span = null
    }

    const fields: Record<string, unknown> = {
      route,
      method: req.method,
      status,
      duration_ms: durationMs,
      ...ids
    }
    if (status >= 500) {
      fields.error_type = errorType
      const { answer, cause } = req.failure ?? {}
      fields.error_message =
        cause instanceof Error
          ? cause.message
          : answer
            ? `${answer.code}: ${answer.message}`
            : "request failed"
    }
    const sc = span?.spanContext()
    if (sc && trace.isSpanContextValid(sc)) {
      fields.trace_id = sc.traceId
      fields.span_id = sc.spanId
    }

    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info"
    req.log[level](fields, "request completed")
  })
}

export const observabilityPlugin = fp(observability, { name: "observability" })
