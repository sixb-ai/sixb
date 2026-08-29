/** Provider-side limits applied independently from delegated grants. */
export interface ObjectReadExecutionLimits {
  /** Maximum number of live roots and selected edge occurrences resolved for one operation. */
  readonly maxTraversalFacts: number
  /** Maximum UTF-8 JSON size returned by one reader operation. */
  readonly maxVisibleJsonBytes: number
}

export type DelegatedExecutionLimitMetric =
  | "traversalFacts"
  | "visibleJsonBytes"
  | "materializedObjects"
  | "telemetrySeries"
  | "telemetryPoints"

const MAX_VISIBLE_JSON_DEPTH = 64

/** Stable, non-observational failure for a delegated execution budget. */
export class DelegatedExecutionLimitError extends Error {
  readonly name = "DelegatedExecutionLimitError"
  readonly code = "delegated_execution_limit_exceeded"
  readonly metric: DelegatedExecutionLimitMetric
  readonly limit: number

  constructor(metric: DelegatedExecutionLimitMetric, limit: number) {
    super(`[Sixb] Delegated execution exceeded its ${metric} limit (${limit}).`)
    this.metric = metric
    this.limit = limit
  }
}

/** Validate and detach limits at every provider boundary. */
export function snapshotObjectReadExecutionLimits(
  limits: ObjectReadExecutionLimits
): ObjectReadExecutionLimits {
  if (typeof limits !== "object" || limits === null) {
    throw new Error("[Sixb] Object read execution limits must be provided.")
  }
  return Object.freeze({
    maxTraversalFacts: positiveSafeInteger(limits.maxTraversalFacts, "maxTraversalFacts"),
    maxVisibleJsonBytes: positiveSafeInteger(limits.maxVisibleJsonBytes, "maxVisibleJsonBytes"),
  })
}

/** Fail before a scoped reader releases an oversized value to its caller. */
export function assertVisibleJsonWithinLimit(
  value: unknown,
  limits: Pick<ObjectReadExecutionLimits, "maxVisibleJsonBytes">
): void {
  const fail = (): never => {
    throw new DelegatedExecutionLimitError("visibleJsonBytes", limits.maxVisibleJsonBytes)
  }
  const depthByObject = new WeakMap<object, number>()
  const serializedChildrenByObject = new WeakMap<object, number>()
  let bytes = 0
  const addBytes = (count: number): void => {
    bytes += count
    if (bytes > limits.maxVisibleJsonBytes) fail()
  }

  try {
    JSON.stringify(value, function (this: unknown, key, current: unknown) {
      const parent = isObject(this) ? this : undefined
      const parentDepth = parent ? depthByObject.get(parent) : undefined
      const isRoot = parentDepth === undefined
      const parentIsArray = Array.isArray(parent)
      const unsupported =
        current === undefined || typeof current === "function" || typeof current === "symbol"

      if (!isRoot) {
        if (!parentIsArray && unsupported) return current
        const serializedChildren = serializedChildrenByObject.get(parent!) ?? 0
        if (serializedChildren > 0) addBytes(1)
        serializedChildrenByObject.set(parent!, serializedChildren + 1)
        if (!parentIsArray) {
          addBytes(jsonStringUtf8Length(key) + 1)
        }
      } else if (unsupported) {
        return current
      }

      if (parentIsArray && unsupported) {
        addBytes(4)
        return current
      }

      switch (typeof current) {
        case "string":
          addBytes(jsonStringUtf8Length(current))
          break
        case "number":
          addBytes(
            Number.isFinite(current) ? (Object.is(current, -0) ? 1 : String(current).length) : 4
          )
          break
        case "boolean":
          addBytes(current ? 4 : 5)
          break
        case "bigint":
          throw new TypeError("BigInt is not JSON serializable")
        case "object":
          if (current === null) {
            addBytes(4)
            break
          }
          if ((parentDepth ?? 0) + 1 > MAX_VISIBLE_JSON_DEPTH) fail()
          depthByObject.set(current, (parentDepth ?? 0) + 1)
          addBytes(2)
          break
      }
      return current
    })
  } catch (error) {
    if (error instanceof DelegatedExecutionLimitError) throw error
    if (error instanceof RangeError || error instanceof TypeError) fail()
    throw error
  }
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
