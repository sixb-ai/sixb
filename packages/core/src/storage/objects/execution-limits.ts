/** Provider-side limits for one selected object-read operation. */
export interface ObjectReadExecutionLimits {
  /** Maximum number of live roots and selected edge occurrences resolved by one operation. */
  readonly maxTraversalFacts: number
  /** Maximum UTF-8 JSON size released by one operation. */
  readonly maxOutputJsonBytes: number
}

export type ObjectReadLimitMetric = "traversalFacts" | "outputJsonBytes"

/** Cross-provider admission bound for one selected-reader facet terminal. */
export const MAX_OBJECT_READ_FACETS = 16

const MAX_OUTPUT_JSON_DEPTH = 64

/** Stable, provider-neutral failure raised when an object-read budget is exhausted. */
export class ObjectReadLimitExceededError extends Error {
  readonly name = "ObjectReadLimitExceededError"
  readonly code = "object_read_limit_exceeded"

  constructor(
    readonly metric: ObjectReadLimitMetric,
    readonly limit: number
  ) {
    super(`[Sixb] Object read exceeded its ${metric} limit (${limit}).`)
  }
}

/** Validate and detach limits at the provider boundary. */
export function snapshotObjectReadExecutionLimits(
  limits: ObjectReadExecutionLimits
): ObjectReadExecutionLimits {
  if (typeof limits !== "object" || limits === null) {
    throw new Error("[Sixb] Object read execution limits must be provided.")
  }
  return Object.freeze({
    maxTraversalFacts: positiveSafeInteger(limits.maxTraversalFacts, "maxTraversalFacts"),
    maxOutputJsonBytes: positiveSafeInteger(limits.maxOutputJsonBytes, "maxOutputJsonBytes"),
  })
}

/** Reject facet fan-out before a provider resolves the selected universe. */
export function assertObjectReadFacetCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_OBJECT_READ_FACETS) {
    throw new Error(
      `[Sixb] An object read supports between 0 and ${MAX_OBJECT_READ_FACETS} facets.`
    )
  }
}

/** Fail before a selected reader releases an oversized value to its caller. */
export function assertObjectReadOutputWithinLimit(
  value: unknown,
  limits: Pick<ObjectReadExecutionLimits, "maxOutputJsonBytes">
): void {
  const fail = (): never => {
    throw new ObjectReadLimitExceededError("outputJsonBytes", limits.maxOutputJsonBytes)
  }
  const stack: Array<{ value: object; serializedChildren: number }> = []
  let bytes = 0
  const addBytes = (count: number): void => {
    bytes += count
    if (bytes > limits.maxOutputJsonBytes) fail()
  }
  const addPrimitiveBytes = (primitive: boolean | number | string): void => {
    switch (typeof primitive) {
      case "string":
        addBytes(jsonStringUtf8Length(primitive))
        break
      case "number":
        addBytes(
          Number.isFinite(primitive) ? (Object.is(primitive, -0) ? 1 : String(primitive).length) : 4
        )
        break
      case "boolean":
        addBytes(primitive ? 4 : 5)
        break
    }
  }

  try {
    JSON.stringify(value, function (this: unknown, key, current: unknown) {
      const parent = isObject(this) ? this : undefined
      let parentFrameIndex = -1
      if (parent) {
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          if (stack[index]?.value === parent) {
            parentFrameIndex = index
            break
          }
        }
      }
      const isRoot = parentFrameIndex === -1
      if (isRoot) {
        stack.length = 0
      } else {
        stack.length = parentFrameIndex + 1
      }
      const parentFrame = isRoot ? undefined : stack[parentFrameIndex]
      const parentIsArray = Array.isArray(parent)
      const unsupported =
        current === undefined || typeof current === "function" || typeof current === "symbol"

      if (!isRoot) {
        if (!parentIsArray && unsupported) return current
        if (!parentFrame) return fail()
        if (parentFrame.serializedChildren > 0) addBytes(1)
        parentFrame.serializedChildren += 1
        if (!parentIsArray) addBytes(jsonStringUtf8Length(key) + 1)
      } else if (unsupported) {
        return current
      }

      if (parentIsArray && unsupported) {
        addBytes(4)
        return current
      }

      if (isObject(current)) {
        // JSON.stringify handles primitive wrappers and raw JSON specially after the replacer.
        // Return an already-coerced primitive so custom Number/String coercion runs exactly once.
        const special = inspectJsonSpecialObject(current)
        switch (special.kind) {
          case "primitive":
            addPrimitiveBytes(special.value)
            return special.value
          case "bigint":
            throw new TypeError("BigInt is not JSON serializable")
          case "raw":
            addBytes(rawJsonUtf8Length(special.value))
            return current
          case "ordinary":
            break
        }
      }

      switch (typeof current) {
        case "string":
          addPrimitiveBytes(current)
          break
        case "number":
          addPrimitiveBytes(current)
          break
        case "boolean":
          addPrimitiveBytes(current)
          break
        case "bigint":
          throw new TypeError("BigInt is not JSON serializable")
        case "object":
          if (current === null) {
            addBytes(4)
            break
          }
          if (stack.some((frame) => frame.value === current)) {
            throw new TypeError("Cyclic object value")
          }
          if (stack.length + 1 > MAX_OUTPUT_JSON_DEPTH) fail()
          addBytes(2)
          stack.push({ value: current, serializedChildren: 0 })
          break
      }
      return current
    })
  } catch (error) {
    if (error instanceof ObjectReadLimitExceededError) throw error
    if (error instanceof RangeError || error instanceof TypeError) fail()
    throw error
  }
}

type JsonSpecialObject =
  | { readonly kind: "ordinary" }
  | { readonly kind: "primitive"; readonly value: boolean | number | string }
  | { readonly kind: "bigint" }
  | { readonly kind: "raw"; readonly value: string }

const jsonWithRawJson = JSON as JSON & {
  isRawJSON?: (value: unknown) => boolean
}
const isRawJson = jsonWithRawJson.isRawJSON?.bind(jsonWithRawJson)
const booleanValueOf = bindValueOf(Boolean.prototype.valueOf)
const numberValueOf = bindValueOf(Number.prototype.valueOf)
const stringValueOf = bindValueOf(String.prototype.valueOf)
const bigintValueOf = bindValueOf(BigInt.prototype.valueOf)
const toStringValue = String

function inspectJsonSpecialObject(value: object): JsonSpecialObject {
  if (isRawJson?.(value)) {
    const raw = (value as { readonly rawJSON?: unknown }).rawJSON
    if (typeof raw !== "string") return { kind: "ordinary" }
    return { kind: "raw", value: raw }
  }

  const boolean = unbox(value, booleanValueOf)
  if (boolean.matched) return { kind: "primitive", value: boolean.value }
  const number = unbox(value, numberValueOf)
  if (number.matched) return { kind: "primitive", value: +(value as unknown as number) }
  const string = unbox(value, stringValueOf)
  if (string.matched) return { kind: "primitive", value: toStringValue(value) }
  if (unbox(value, bigintValueOf).matched) return { kind: "bigint" }
  return { kind: "ordinary" }
}

function bindValueOf<T>(unboxer: (this: object) => T): (value: object) => T {
  return Function.prototype.call.bind(unboxer) as (value: object) => T
}

function unbox<T>(
  value: object,
  unboxer: (value: object) => T
): { readonly matched: true; readonly value: T } | { readonly matched: false } {
  try {
    return { matched: true, value: unboxer(value) }
  } catch {
    return { matched: false }
  }
}

function rawJsonUtf8Length(value: string): number {
  // Raw JSON is already escaped source text. Count its encoded bytes directly without allocating
  // a second encoded buffer proportional to the caller-controlled payload.
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

function jsonStringUtf8Length(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c) {
      bytes += 2
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
    } else if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
  }
  return bytes
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[Sixb] ${name} must be a positive safe integer.`)
  }
  return value
}
