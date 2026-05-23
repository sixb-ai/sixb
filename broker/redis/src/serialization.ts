import type { BrokerRecord, BrokerRecordInput } from "@sixb/core"
import { getInvalidJsonValueReason, type JsonValue } from "@sixb/core"
import { RedisBrokerError } from "./errors"

interface WireBrokerRecord {
  readonly name?: string
  readonly key?: string
  readonly payload?: unknown
  readonly publishedAt: string
}

export function encodeRecord(input: BrokerRecordInput, publishedAt: string): string {
  assertBrokerPayload(input.payload)

  return JSON.stringify({
    name: input.name,
    key: input.key,
    payload: input.payload,
    publishedAt,
  } satisfies WireBrokerRecord)
}

export function assertEncodableRecord(input: BrokerRecordInput): void {
  assertBrokerPayload(input.payload)
}

export function decodeRecord(params: {
  readonly streamId: string
  readonly body: string
  readonly cursor: string
  readonly fallbackPublishedAt: string
}): BrokerRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(params.body)
  } catch (error) {
    throw new RedisBrokerError("Failed to decode broker record body as JSON", { cause: error })
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RedisBrokerError("Decoded broker record body is not an object")
  }

  const record = parsed as Partial<WireBrokerRecord>
  if (!("payload" in record)) {
    throw new RedisBrokerError("Decoded broker record body is missing payload")
  }
  assertBrokerPayload(record.payload)

  return {
    streamId: params.streamId,
    cursor: params.cursor,
    name: typeof record.name === "string" ? record.name : undefined,
    key: typeof record.key === "string" ? record.key : undefined,
    payload: record.payload,
    publishedAt:
      typeof record.publishedAt === "string" ? record.publishedAt : params.fallbackPublishedAt,
  }
}

function assertBrokerPayload(payload: unknown): asserts payload is JsonValue {
  const reason = getInvalidJsonValueReason(payload, "record.payload")
  if (reason) {
    throw new RedisBrokerError(`record.payload must be a JSON value; ${reason}`)
  }
}
