import { metrics, trace } from "@opentelemetry/api"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  AggregationTemporality,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler
} from "@opentelemetry/sdk-trace-base"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION
} from "@opentelemetry/semantic-conventions"
import type { AppConfig } from "./config.js"
import { initOtelInstruments } from "./metrics.js"

const normalizeEndpoint = (base: string, suffix: string): string => {
  const trimmed = base.replace(/\/$/, "")
  if (trimmed.endsWith(suffix)) return trimmed
  return `${trimmed}${suffix}`
}

const exporterIncludes = (
  list: ReadonlyArray<string> | undefined,
  name: string
): boolean => (list ?? []).includes(name)

const tracesDestination = (config: AppConfig): string | undefined =>
  config.otlpTracesEndpoint ??
  (config.otlpEndpoint
    ? normalizeEndpoint(config.otlpEndpoint, "/v1/traces")
    : undefined)

const metricsDestination = (config: AppConfig): string | undefined =>
  config.otlpMetricsEndpoint ??
  (config.otlpEndpoint
    ? normalizeEndpoint(config.otlpEndpoint, "/v1/metrics")
    : undefined)

const tracesOtlpEnabled = (config: AppConfig): boolean => {
  if (config.otelSdkDisabled) return false
  if (!tracesDestination(config)) return false
  if (config.tracesExporters === undefined) return true
  return exporterIncludes(config.tracesExporters, "otlp")
}

const metricsOtlpEnabled = (config: AppConfig): boolean => {
  if (config.otelSdkDisabled) return false
  if (!metricsDestination(config)) return false
  if (config.metricsExporters === undefined) return true
  return exporterIncludes(config.metricsExporters, "otlp")
}

export type TelemetryHandle = {
  shutdown: () => Promise<void>
}

export const initTelemetry = (config: AppConfig): TelemetryHandle => {
  const resource = resourceFromAttributes({
    ...config.resourceAttributes,
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    "service.namespace": config.serviceNamespace,
    "service.instance.id": config.serviceInstanceId,
    "deployment.environment": config.deploymentEnv
  })

  const enableTraces = tracesOtlpEnabled(config)
  const enableMetricsOtlp = metricsOtlpEnabled(config)

  if (!enableTraces && !enableMetricsOtlp) {
    // Still bind instruments so dual-write is a no-op against the global meter.
    initOtelInstruments()
    return { shutdown: async () => undefined }
  }

  const ratio = Math.min(1, Math.max(0, config.tracesSamplerRatio))
  const spanProcessors = enableTraces
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: tracesDestination(config)! })
        )
      ]
    : []

  const metricReader = enableMetricsOtlp
    ? new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: metricsDestination(config)!,
          temporalityPreference: AggregationTemporality.CUMULATIVE
        }),
        exportIntervalMillis: config.metricExportIntervalMs
      })
    : undefined

  const sdk = new NodeSDK({
    resource,
    spanProcessors,
    metricReader,
    sampler: enableTraces
      ? new ParentBasedSampler({
          root: new TraceIdRatioBasedSampler(ratio)
        })
      : undefined
  })

  sdk.start()
  // After MeterProvider is installed (gateway/route-registry pattern).
  initOtelInstruments()

  return {
    shutdown: async () => {
      await sdk.shutdown()
    }
  }
}

export const getTracer = (name = "api") => trace.getTracer(name)

export const getMeter = (name = "api") => metrics.getMeter(name)
