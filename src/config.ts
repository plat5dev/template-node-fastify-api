export type Env = Readonly<Record<string, string | undefined>>

export type AppConfig = {
  readonly port: number
  readonly internalPort: number
  readonly databasePath: string
  /** Identity's internal base URL (trailing slash stripped), or undefined when unset. */
  readonly identityInternalUrl: string | undefined
  /** Permission a task's assignee must hold on the task's project. */
  readonly taskAssigneePermission: string
  /** OTLP collector base URL when set; OTel SDK reads all other OTEL_* env vars natively. */
  readonly otlpEndpoint: string | undefined
  /** Service version reported in OpenAPI and OTel resource attributes. */
  readonly version: string
}

const PERMISSION_NAME = /^[a-z0-9:._-]{1,64}$/

const optional = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined

const parsePort = (env: Env, name: string, fallback: number): number => {
  const raw = optional(env, name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} is "${raw}": want a port number (1-65535)`)
  }
  return n
}

const parseHttpUrl = (env: Env, name: string): string | undefined => {
  const raw = optional(env, name)
  if (raw === undefined) return undefined
  const url = URL.parse(raw)
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") {
    throw new Error(`${name} is "${raw}": want an http:// or https:// URL`)
  }
  return raw.replace(/\/+$/, "")
}

export const loadConfig = (env: Env = process.env): AppConfig => {
  const taskAssigneePermission = env.TASK_ASSIGNEE_PERMISSION
  if (taskAssigneePermission === undefined || !PERMISSION_NAME.test(taskAssigneePermission)) {
    throw new Error(
      "TASK_ASSIGNEE_PERMISSION is required and must match [a-z0-9:._-]{1,64} (e.g. project:read)"
    )
  }

  return {
    port: parsePort(env, "PORT", 3000),
    internalPort: parsePort(env, "INTERNAL_PORT", 3001),
    databasePath: optional(env, "DATABASE_PATH") ?? "./data/app.db",
    identityInternalUrl: parseHttpUrl(env, "IDENTITY_INTERNAL_URL"),
    taskAssigneePermission,
    otlpEndpoint: parseHttpUrl(env, "OTEL_EXPORTER_OTLP_ENDPOINT"),
    version: optional(env, "APP_VERSION") ?? "dev"
  }
}
