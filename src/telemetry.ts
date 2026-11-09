/**
 * OpenTelemetry per plat5 docs/reference/telemetry.md.
 *
 * Metrics: one MeterProvider, whose series (metrics.ts) the Prometheus reader serves on
 * `/metrics` always, and an OTLP reader pushes when that's on. Traces: a TracerProvider
 * exporting over OTLP when that's on; otherwise spans aren't recorded. W3C Trace Context is
 * the propagator either way, so `traceparent` passes from the front door to identity
 * (plat5 docs/guides/write-a-service.md#rules). The OTLP exporters also read their own
 * standard settings, OTEL_EXPORTER_OTLP_HEADERS among them.
 */
import { DiagLogLevel, type DiagLogger, diag, propagation, trace } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources"
import {
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics"
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider
} from "@opentelemetry/sdk-trace"
import type { AppConfig } from "./config.ts"
import type { MetricsHandler } from "./internal.ts"
import { log } from "./log.ts"
import { initMetrics } from "./metrics.ts"

/** An error's message: OpenTelemetry hands an exception over as JSON, stack and all. */
const messageOf = (text: string): string => {
  try {
    const message = (JSON.parse(text) as { message?: unknown } | null)?.message
    if (typeof message === "string") return message
  } catch {
    // Not JSON: the text is the message.
  }
  return text
}

const logLine =
  (level: "error" | "warn", message: string) =>
  (text: string, ...args: unknown[]): void =>
    log(level, message, { error_message: [messageOf(text), ...args.map(String)].join(" ") })

/** OpenTelemetry's errors and warnings, a failed export say, each one JSON line; the API keeps serving. */
export const diagLogger: DiagLogger = {
  error: logLine("error", "telemetry error"),
  warn: logLine("warn", "telemetry warning"),
  info: () => undefined,
  debug: () => undefined,
  verbose: () => undefined
}

export type Telemetry = {
  /** Answers `/metrics`. */
  metrics: MetricsHandler
  shutdown: () => Promise<void>
}

export const initTelemetry = (config: AppConfig): Telemetry => {
  diag.setLogger(diagLogger, DiagLogLevel.WARN)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  // config layers the resource; it wins over the SDK's defaults.
  const resource = defaultResource().merge(resourceFromAttributes(config.resource))

  // Served by the internal server, so no server of its own; the series as named, no scope labels or target_info.
  const prometheus = new PrometheusExporter({
    preventServerStart: true,
    withoutScopeInfo: true,
    withoutTargetInfo: true
  })
  const readers: MetricReader[] = [prometheus]
  if (config.otlpMetricsUrl !== undefined) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: config.otlpMetricsUrl }),
        exportIntervalMillis: config.metricExportIntervalMs
      })
    )
  }
  const meterProvider = new MeterProvider({ resource, readers })
  initMetrics(meterProvider.getMeter("api"))

  let tracerProvider: TracerProvider | undefined
  if (config.otlpTracesUrl !== undefined) {
    tracerProvider = new TracerProvider({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(config.tracesSamplerRatio)
      }),
      spanProcessors: [
        new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: config.otlpTracesUrl }) })
      ]
    })
    trace.setGlobalTracerProvider(tracerProvider)
  }

  return {
    metrics: (req, res) => prometheus.getMetricsRequestHandler(req, res),
    shutdown: async () => {
      await Promise.all([meterProvider.shutdown(), tracerProvider?.shutdown()])
    }
  }
}
