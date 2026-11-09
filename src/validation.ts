/**
 * A request that doesn't match its route's schema, in Plat5's words: a 422 listing each wrong
 * field at its path (`title`, `address.street`, `tags[0].name`; the body itself is `body`),
 * with the route's sentence for it, else the fallback one (plat5 docs/reference/errors.md).
 *
 * A body with unknown keys is refused for those alone, before its values are checked, each
 * `<path> isn't a field.`. Otherwise each wrong field is named once, for its first issue, in
 * the body's order.
 */
import type { FastifySchemaValidationError } from "fastify"
import { type ApiError, FALLBACK_VALIDATION, type Field, validationError } from "./errors.ts"
import type { Messages } from "./schemas.ts"

/**
 * An AJV instance path (`/tags/0/name`) as a Plat5 field path (`tags[0].name`), with `key`, an
 * object's key, after it.
 */
const pathOf = (pointer: string, key?: string): string => {
  const path = pointer
    .split("/")
    .slice(1)
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((out, s) => (/^\d+$/.test(s) ? `${out}[${s}]` : out === "" ? s : `${out}.${s}`), "")
  return key === undefined ? path : path === "" ? key : `${path}.${key}`
}

/** The 422 for `errors`, AJV's for the request's `part` (`body`, `querystring`…), which held `data`. */
export const validationFailed = (
  errors: readonly FastifySchemaValidationError[],
  part: string | undefined,
  data: unknown,
  messages: Messages = {}
): ApiError => {
  const unknown: Field[] = []
  const known: Field[] = []
  for (const e of errors) {
    const params = e.params as { additionalProperty?: string; missingProperty?: string }
    if (e.keyword === "additionalProperties" && params.additionalProperty !== undefined) {
      const path = pathOf(e.instancePath, params.additionalProperty)
      unknown.push({ path, message: `${path} isn't a field.` })
      continue
    }
    const path = pathOf(e.instancePath, params.missingProperty) || "body"
    const sentences = messages[path]
    known.push({ path, message: sentences?.[e.keyword] ?? sentences?.["*"] ?? FALLBACK_VALIDATION })
  }
  if (unknown.length > 0) return validationError(unknown)
  // A field once, for its first issue.
  const seen = new Set<string>()
  const fields = known.filter((f) => !seen.has(f.path) && seen.add(f.path))
  if (part === "body" && typeof data === "object" && data !== null) {
    // AJV goes in the schema's order; the body's is the client's. A key it hasn't goes last.
    const keys = Object.keys(data)
    const at = (f: Field) => {
      const i = keys.indexOf(f.path.split(/[.[]/)[0]!)
      return i < 0 ? keys.length : i
    }
    fields.sort((a, b) => at(a) - at(b))
  }
  return validationError(fields)
}
