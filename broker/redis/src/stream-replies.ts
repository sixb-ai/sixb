import { redisBrokerError } from "./errors"

export interface RedisStreamEntry {
  readonly id: string
  readonly fields: ReadonlyMap<string, string>
}

export function parseStreamEntries(reply: unknown): readonly RedisStreamEntry[] {
  if (!Array.isArray(reply)) {
    throw redisBrokerError("Redis stream range reply was not an array")
  }

  return reply.map(parseStreamEntry)
}

export function parseXReadEntries(reply: unknown): readonly RedisStreamEntry[] {
  if (reply === null) {
    return []
  }

  const entries: RedisStreamEntry[] = []
  if (Array.isArray(reply)) {
    for (const stream of reply) {
      if (!Array.isArray(stream) || stream.length !== 2 || !Array.isArray(stream[1])) {
        throw redisBrokerError("Redis XREAD stream reply was malformed")
      }
      for (const entry of stream[1]) {
        entries.push(parseStreamEntry(entry))
      }
    }
    return entries
  }

  if (typeof reply === "object") {
    for (const streamEntries of Object.values(reply)) {
      if (!Array.isArray(streamEntries)) {
        throw redisBrokerError("Redis XREAD stream reply was malformed")
      }
      for (const entry of streamEntries) {
        entries.push(parseStreamEntry(entry))
      }
    }
    return entries
  }

  throw redisBrokerError("Redis XREAD reply was not an array or object")
}

export function bodyFromEntry(entry: RedisStreamEntry): string {
  const body = entry.fields.get("body")
  if (body === undefined) {
    throw redisBrokerError("Redis stream entry is missing body field")
  }
  return body
}

function parseStreamEntry(entry: unknown): RedisStreamEntry {
  if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) {
    throw redisBrokerError("Redis stream entry reply was malformed")
  }

  const id = toText(entry[0])
  const rawFields = entry[1]
  if (rawFields.length % 2 !== 0) {
    throw redisBrokerError("Redis stream entry field list had odd length")
  }

  const fields = new Map<string, string>()
  for (let index = 0; index < rawFields.length; index += 2) {
    fields.set(toText(rawFields[index]), toText(rawFields[index + 1]))
  }

  return { id, fields }
}

export function toText(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8")
  }
  throw redisBrokerError("Redis reply value was not a string")
}
