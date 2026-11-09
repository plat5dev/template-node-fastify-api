/** One JSON line on stdout (plat5 docs/reference/telemetry.md#logs). */
export const log = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {}
): void => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields }))
}

/** An error's message, for `error_message`. */
export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)
