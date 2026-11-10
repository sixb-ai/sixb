import type { JsonObject, JsonValue } from "@sixb/core/models"

/**
 * A tool's schema in the form OpenAI's strict mode takes: every property required, and an optional
 * one nullable instead, unless it already allows null. The model then sends `null` for "nothing",
 * which core leaves out before the tool parses its input. Left optional under strict mode, the
 * property is filled anyway: an empty string, or whatever the model invents.
 *
 * Only the rewrite: each adapter still checks the result against its provider's strict subset.
 */
export function requiredNullableSchema(schema: JsonObject): JsonObject {
  return rewrite(structuredClone(schema)) as JsonObject
}

function rewrite(node: JsonValue): JsonValue {
  if (!isObject(node)) return node
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = node[key]
    if (Array.isArray(variants)) node[key] = variants.map(rewrite)
  }
  for (const key of ["$defs", "definitions"] as const) {
    const definitions = node[key]
    if (isObject(definitions)) node[key] = mapValues(definitions, rewrite)
  }
  if (node.items !== undefined) {
    node.items = Array.isArray(node.items) ? node.items.map(rewrite) : rewrite(node.items)
  }
  const properties = node.properties
  if (!isObject(properties)) return node

  const required = new Set(Array.isArray(node.required) ? node.required : [])
  node.properties = mapEntries(properties, (key, property) => {
    const strict = rewrite(property)
    return required.has(key) || allowsNull(strict) ? strict : nullable(strict)
  })
  node.required = Object.keys(properties)
  return node
}

/** `type: [T, "null"]` keeps a simple property's own keywords in place; anything else is wrapped. */
function nullable(property: JsonValue): JsonValue {
  if (
    isObject(property) &&
    typeof property.type === "string" &&
    property.enum === undefined &&
    property.const === undefined
  ) {
    return { ...property, type: [property.type, "null"] }
  }
  return { anyOf: [property, { type: "null" }] }
}

/**
 * What Anthropic's strict mode takes in one request, across its strict tools and its JSON output
 * schema: past any of them it refuses the whole request.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
export const MESSAGES_STRICT_LIMITS = { tools: 20, optional: 24, unions: 16 } as const

export interface MessagesStrictCandidate {
  /** The tool asked for strict arguments. */
  readonly strict?: boolean
  /** Its schema in the provider's strict subset, or undefined when it has none. */
  readonly schema: JsonObject | undefined
}

/**
 * Which tools a Messages request sends strict: in order, each that asked and fits what is left of
 * {@link MESSAGES_STRICT_LIMITS} after the output schema. The same tools always choose the same,
 * so the request stays the prefix the provider cached.
 */
export function messagesStrictTools(
  tools: readonly MessagesStrictCandidate[],
  outputSchema?: JsonObject
): readonly boolean[] {
  const used = outputSchema ? strictParameters(outputSchema) : { optional: 0, unions: 0 }
  let strictTools = 0
  return tools.map(({ strict, schema }) => {
    if (!strict || !schema) return false
    const { optional, unions } = strictParameters(schema)
    if (
      strictTools + 1 > MESSAGES_STRICT_LIMITS.tools ||
      used.optional + optional > MESSAGES_STRICT_LIMITS.optional ||
      used.unions + unions > MESSAGES_STRICT_LIMITS.unions
    ) {
      return false
    }
    strictTools += 1
    used.optional += optional
    used.unions += unions
    return true
  })
}

/** The properties a schema leaves optional, and those typed as a union, at every depth. */
function strictParameters(schema: JsonObject): { optional: number; unions: number } {
  const counts = { optional: 0, unions: 0 }
  const visit = (node: JsonValue, parameter: boolean) => {
    if (!isObject(node)) return
    if (parameter && isUnion(node)) counts.unions += 1
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const variants = node[key]
      if (Array.isArray(variants)) for (const variant of variants) visit(variant, false)
    }
    for (const key of ["$defs", "definitions"] as const) {
      const definitions = node[key]
      if (isObject(definitions)) for (const value of Object.values(definitions)) visit(value, false)
    }
    if (Array.isArray(node.items)) for (const item of node.items) visit(item, true)
    else if (node.items !== undefined) visit(node.items, true)
    if (!isObject(node.properties)) return
    const required = new Set(Array.isArray(node.required) ? node.required : [])
    for (const [key, property] of Object.entries(node.properties)) {
      if (!required.has(key)) counts.optional += 1
      visit(property, true)
    }
  }
  visit(schema, false)
  return counts
}

function isUnion(node: JsonObject): boolean {
  return (
    Array.isArray(node.anyOf) ||
    Array.isArray(node.oneOf) ||
    (Array.isArray(node.type) && node.type.length > 1)
  )
}

/**
 * Anthropic's refusal of a request's strict tools: past a counted limit, or a grammar too large to
 * compile, which no count predicts. The request is sent again with no strict tools.
 */
export function isStrictToolLimitError(error: {
  readonly status?: number
  readonly message: string
}): boolean {
  return (
    error.status === 400 &&
    /compiled grammar is too large|schema is too complex|too many strict tools|too many (optional )?parameters/i.test(
      error.message
    )
  )
}

/**
 * The strict tool sets a provider refused, by their content, so a later request with the same tools
 * sends them unconstrained at once: the tools rarely change between a conversation's calls, and the
 * same request each time keeps the provider's prompt cache.
 */
export class StrictToolRefusals {
  readonly #refused = new Set<string>()

  constructor(private readonly capacity = 1_000) {}

  has(key: string): boolean {
    return this.#refused.has(key)
  }

  add(key: string): void {
    this.#refused.delete(key)
    this.#refused.add(key)
    if (this.#refused.size > this.capacity) {
      const oldest = this.#refused.values().next().value
      if (oldest !== undefined) this.#refused.delete(oldest)
    }
  }
}

/**
 * A request's strict tools, as a key: their definitions in order, hashed (cyrb53, 53 bits; the
 * package also runs in browser bundles). A collision only sends one set unconstrained.
 */
export function strictToolsKey(tools: readonly JsonValue[]): string {
  const text = JSON.stringify(tools)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function allowsNull(schema: JsonValue): boolean {
  if (schema === true) return true
  if (!isObject(schema)) return false
  const types = typeof schema.type === "string" ? [schema.type] : schema.type
  if (Array.isArray(types) && types.includes("null")) return true
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) {
    return true
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key]
    if (Array.isArray(variants) && variants.some(allowsNull)) return true
  }
  return false
}

function mapValues(record: JsonObject, map: (value: JsonValue) => JsonValue): JsonObject {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))
}

function mapEntries(
  record: JsonObject,
  map: (key: string, value: JsonValue) => JsonValue
): JsonObject {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(key, value)]))
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
