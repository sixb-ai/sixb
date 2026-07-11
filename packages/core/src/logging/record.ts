import { getInvalidJsonValueReason, type JsonValue } from "../json"
import type { LogEntry, LogFields, LogRecord } from "./types"

const textEncoder = new TextEncoder()

/** Build the provider-independent, redacted and byte-bounded broker copy. */
export function sanitizeRecord(
  entry: LogEntry,
  options: {
    readonly maxBytes: number
    readonly redactPaths: readonly string[]
    readonly redactCensor: JsonValue
  }
): LogRecord {
  const fields = sanitizeFields(entry.fields, options.redactPaths, options.redactCensor)
  let record: LogRecord = {
    level: entry.level,
    message: entry.message,
    ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
    at: entry.at,
    context: entry.context,
  }
  const originalBytes = serializedBytes(record)
  if (originalBytes <= options.maxBytes) {
    return record
  }

  record = {
    ...record,
    fields: { sixb_truncated: true, originalBytes },
  }
  if (serializedBytes(record) <= options.maxBytes) {
    return record
  }

  const characters = Array.from(record.message)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = { ...record, message: characters.slice(0, middle).join("") }
    if (serializedBytes(candidate) <= options.maxBytes) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  return { ...record, message: characters.slice(0, low).join("") }
}

export function serializedBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength
}

function sanitizeFields(
  fields: LogFields | undefined,
  redactPaths: readonly string[],
  censor: JsonValue
): LogFields | undefined {
  if (!fields) {
    return undefined
  }
  const reason = getInvalidJsonValueReason(fields, "log fields")
  if (reason) {
    return { sixb_unloggableFields: reason }
  }

  const copy = JSON.parse(JSON.stringify(fields)) as LogFields
  for (const configuredPath of redactPaths) {
    const path = configuredPath.startsWith("fields.")
      ? configuredPath.slice("fields.".length)
      : configuredPath
    redactPath(copy, path.split(".").filter(Boolean), censor)
  }
  return copy
}

function redactPath(target: JsonValue, path: readonly string[], censor: JsonValue): void {
  if (path.length === 0 || typeof target !== "object" || target === null) {
    return
  }
  const [head, ...tail] = path
  if (!head) {
    return
  }

  if (head === "*") {
    const values = Array.isArray(target) ? target : Object.values(target)
    if (tail.length === 0) {
      if (Array.isArray(target)) {
        target.fill(censor)
      } else {
        for (const key of Object.keys(target)) {
          target[key] = censor
        }
      }
      return
    }
    for (const value of values) {
      redactPath(value, tail, censor)
    }
    return
  }

  if (Array.isArray(target)) {
    const index = Number(head)
    if (!Number.isSafeInteger(index) || index < 0 || index >= target.length) {
      return
    }
    if (tail.length === 0) {
      target[index] = censor
    } else {
      redactPath(target[index]!, tail, censor)
    }
    return
  }

  if (!(head in target)) {
    return
  }
  if (tail.length === 0) {
    target[head] = censor
  } else {
    redactPath(target[head]!, tail, censor)
  }
}
