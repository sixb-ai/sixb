import { RequestBodyTooLargeError, readRequestBodyWithLimit } from "./request-body"

/**
 * Hard transport ceiling for structural read requests.
 *
 * Object queries and bulk telemetry selectors are compact control payloads, not data uploads. One
 * MiB leaves ample room for the supported query/series bounds while stopping Elysia's JSON parser
 * from buffering an attacker-controlled body before Core can apply execution limits.
 */
export const READ_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024

// Keep the transport query envelope at or below Core's structural query contract. This preflight
// protects the recursive Zod schema; Core remains the authoritative semantic validator.
const MAX_OBJECT_QUERY_STRUCTURE_NODES = 512
const MAX_OBJECT_QUERY_STRUCTURE_DEPTH = 32
const MAX_OBJECT_QUERY_ARRAY_ENTRIES = 4_096

// Predicate values are recursively validated as JSON by Zod. Bound their depth independently from
// query structure so a shallow query cannot hide a stack-exhausting scalar value.
const MAX_OBJECT_QUERY_JSON_VALUE_DEPTH = 64

// This is a transport ceiling, not delegated authority. Core applies the lower execution-specific
// series budget (100 by default) after authentication; the HTTP cap only bounds pre-auth parsing.
export const MAX_TELEMETRY_HISTORY_SERIES_PER_HTTP_REQUEST = 4_096

export class InvalidReadRequestBodyError extends Error {
  readonly name = "InvalidReadRequestBodyError"
}

type QueryWorkItem = {
  readonly kind: "query" | "predicate" | "expansion"
  readonly value: unknown
  readonly depth: number
}

export async function parseBoundedObjectQueryBody(context: {
  readonly request: Request
}): Promise<unknown> {
  const body = await parseBoundedJsonBody(context.request)
  assertObjectQueryRequestStructure(body)
  return body
}

export async function parseBoundedTelemetryHistoryBody(context: {
  readonly request: Request
}): Promise<unknown> {
  const body = await parseBoundedJsonBody(context.request)
  assertTelemetryHistoryRequestStructure(body)
  return body
}

export function mapReadRequestParseError(context: {
  readonly error: unknown
  readonly set: { status?: number | string }
}): { error: string } | undefined {
  const tooLarge = findCause(context.error, RequestBodyTooLargeError)
  if (tooLarge) {
    context.set.status = 413
    return { error: tooLarge.message }
  }

  const invalid = findCause(context.error, InvalidReadRequestBodyError)
  if (invalid) {
    context.set.status = 400
    return { error: invalid.message }
  }

  return undefined
}

async function parseBoundedJsonBody(request: Request): Promise<unknown> {
  const bytes = await readRequestBodyWithLimit(
    request,
    READ_REQUEST_BODY_LIMIT_BYTES,
    `[SixbServer] Read request body exceeds the ${READ_REQUEST_BODY_LIMIT_BYTES}-byte limit.`
  )

  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return JSON.parse(json) as unknown
  } catch {
    throw new InvalidReadRequestBodyError(
      "[SixbServer] Read request body must contain valid UTF-8 JSON."
    )
  }
}

function assertObjectQueryRequestStructure(body: unknown): void {
  if (!isRecord(body) || !isRecord(body.query)) return

  const stack: QueryWorkItem[] = [{ kind: "query", value: body.query, depth: 0 }]
  let nodes = 0
  let arrayEntries = 0

  const readArray = (value: unknown): readonly unknown[] => {
    if (!Array.isArray(value)) return []
    arrayEntries += value.length
    if (arrayEntries > MAX_OBJECT_QUERY_ARRAY_ENTRIES) {
      throw invalid(
        `Object query exceeds the maximum of ${MAX_OBJECT_QUERY_ARRAY_ENTRIES} array entries.`
      )
    }
    return value
  }

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item || !isRecord(item.value)) continue

    if (item.depth > MAX_OBJECT_QUERY_STRUCTURE_DEPTH) {
      throw invalid(
        `Object query exceeds the maximum structural depth of ${MAX_OBJECT_QUERY_STRUCTURE_DEPTH}.`
      )
    }

    nodes += 1
    if (nodes > MAX_OBJECT_QUERY_STRUCTURE_NODES) {
      throw invalid(
        `Object query exceeds the maximum of ${MAX_OBJECT_QUERY_STRUCTURE_NODES} structural nodes.`
      )
    }

    if (item.kind === "query") {
      enqueueQuery(item, stack, readArray)
    } else if (item.kind === "predicate") {
      enqueuePredicate(item, stack, readArray)
    } else {
      enqueueExpansion(item, stack, readArray)
    }
  }
}

function enqueueQuery(
  item: QueryWorkItem,
  stack: QueryWorkItem[],
  readArray: (value: unknown) => readonly unknown[]
): void {
  const query = item.value as Record<string, unknown>
  switch (query.kind) {
    case "refs":
      readArray(query.refs)
      return
    case "filter":
      stack.push({ kind: "predicate", value: query.predicate, depth: item.depth + 1 })
      pushQueryInput(query.input, item.depth, stack)
      return
    case "text":
      readArray(query.fields)
      pushQueryInput(query.input, item.depth, stack)
      return
    case "vector":
      readArray(query.vector)
      pushQueryInput(query.input, item.depth, stack)
      return
    case "traverse":
    case "limit":
    case "page":
      pushQueryInput(query.input, item.depth, stack)
      return
    case "sort":
      readArray(query.fields)
      pushQueryInput(query.input, item.depth, stack)
      return
    case "project":
      readArray(query.properties)
      pushQueryInput(query.input, item.depth, stack)
      return
    case "set":
      pushChildren("query", readArray(query.inputs), item.depth, stack)
      return
    case "expand":
      pushChildren("expansion", readArray(query.expansions), item.depth, stack)
      pushQueryInput(query.input, item.depth, stack)
      return
    default:
      return
  }
}

function enqueuePredicate(
  item: QueryWorkItem,
  stack: QueryWorkItem[],
  readArray: (value: unknown) => readonly unknown[]
): void {
  const predicate = item.value as Record<string, unknown>
  switch (predicate.op) {
    case "and":
    case "or":
      pushChildren("predicate", readArray(predicate.items), item.depth, stack)
      return
    case "not":
      stack.push({ kind: "predicate", value: predicate.item, depth: item.depth + 1 })
      return
    case "in":
      for (const value of readArray(predicate.values)) assertJsonValueDepth(value)
      return
    case "eq":
    case "neq":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
    case "contains":
      assertJsonValueDepth(predicate.value)
      return
    default:
      return
  }
}

function enqueueExpansion(
  item: QueryWorkItem,
  stack: QueryWorkItem[],
  readArray: (value: unknown) => readonly unknown[]
): void {
  const expansion = item.value as Record<string, unknown>
  readArray(expansion.orderBy)
  pushChildren("expansion", readArray(expansion.expand), item.depth, stack)
}

function pushQueryInput(input: unknown, parentDepth: number, stack: QueryWorkItem[]): void {
  stack.push({ kind: "query", value: input, depth: parentDepth + 1 })
}

function pushChildren(
  kind: QueryWorkItem["kind"],
  values: readonly unknown[],
  parentDepth: number,
  stack: QueryWorkItem[]
): void {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    stack.push({ kind, value: values[index], depth: parentDepth + 1 })
  }
}

function assertJsonValueDepth(value: unknown): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }]

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item || typeof item.value !== "object" || item.value === null) continue
    if (item.depth > MAX_OBJECT_QUERY_JSON_VALUE_DEPTH) {
      throw invalid(
        `Object query JSON values exceed the maximum depth of ${MAX_OBJECT_QUERY_JSON_VALUE_DEPTH}.`
      )
    }

    if (Array.isArray(item.value)) {
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item.value[index], depth: item.depth + 1 })
      }
      continue
    }

    for (const child of Object.values(item.value)) {
      stack.push({ value: child, depth: item.depth + 1 })
    }
  }
}

function assertTelemetryHistoryRequestStructure(body: unknown): void {
  if (!isRecord(body) || !Array.isArray(body.series)) return
  if (body.series.length > MAX_TELEMETRY_HISTORY_SERIES_PER_HTTP_REQUEST) {
    throw invalid(
      `Telemetry history supports at most ${MAX_TELEMETRY_HISTORY_SERIES_PER_HTTP_REQUEST} series per HTTP request.`
    )
  }
}

function findCause<TError extends Error>(
  error: unknown,
  errorType: new (...args: never[]) => TError
): TError | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 3; depth += 1) {
    if (current instanceof errorType) return current
    current = (current as { cause?: unknown } | null | undefined)?.cause
  }
  return undefined
}

function invalid(message: string): InvalidReadRequestBodyError {
  return new InvalidReadRequestBodyError(`[SixbServer] ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
