import { diag, type DiagLogger, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler
} from "@opentelemetry/sdk-trace-base"
import type { AppConfig } from "./config.js"
import { initOtelInstruments } from "./metrics.js"

export type TelemetryHandle = {
  shutdown: () => Promise<void>
}

/** An error's message: OpenTelemetry hands an exception over as JSON, stack and all. */
const messageOf = (text: string): string => {
  try {
    const parsed: unknown = JSON.parse(text)
    const message = (parsed as { message?: unknown } | null)?.message
    if (typeof message === "string") return message
  } catch {
    // Not JSON: the text is the message.
  }
  return text
}

/** An OpenTelemetry error or warning, a failed export say, as one JSON line on stdout. */
const logLine =
  (level: "error" | "warn", message: string) =>
  (text: string, ...args: unknown[]): void => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        error_message: [messageOf(text), ...args.map(String)].join(" ")
      })
    )
  }

/** OpenTelemetry's errors and warnings, a failed export say, each one JSON line; the API keeps serving. */
export const diagLogger: DiagLogger = {
  error: logLine("error", "telemetry error"),
  warn: logLine("warn", "telemetry warning"),
  info: () => undefined,
  debug: () => undefined,
  verbose: () => undefined
}

/**
 * OpenTelemetry per plat5 docs/reference/telemetry.md, from `config`. The OTLP exporters
 * also read their own standard settings, OTEL_EXPORTER_OTLP_HEADERS among them.
 *
 * W3C Trace Context is the propagator either way, so `traceparent` passes from the front
 * door to downstream calls with OTLP off (plat5 docs/guides/write-a-service.md#rules).
 */
export const initTelemetry = (config: AppConfig): TelemetryHandle => {
  diag.setLogger(diagLogger, DiagLogLevel.WARN)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())

  // config layers the resource; it wins over the SDK's defaults.
  const resource = defaultResource().merge(resourceFromAttributes(config.resource))

  const providers: { shutdown: () => Promise<void> }[] = []

  if (config.otlpTracesUrl !== undefined) {
    const tracerProvider = new BasicTracerProvider({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(config.tracesSamplerRatio)
      }),
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter({ url: config.otlpTracesUrl }))
      ]
    })
    trace.setGlobalTracerProvider(tracerProvider)
    providers.push(tracerProvider)
  }

  if (config.otlpMetricsUrl !== undefined) {
    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: config.otlpMetricsUrl }),
          exportIntervalMillis: config.metricExportIntervalMs
        })
      ]
    })
    metrics.setGlobalMeterProvider(meterProvider)
    providers.push(meterProvider)
  }

  // After the MeterProvider is installed; with OTLP metrics off they bind to the no-op meter.
  initOtelInstruments()

  return {
    shutdown: async () => {
      await Promise.all(providers.map((p) => p.shutdown()))
    }
  }
}

export const getTracer = (name = "api") => trace.getTracer(name)

export const getMeter = (name = "api") => metrics.getMeter(name)
