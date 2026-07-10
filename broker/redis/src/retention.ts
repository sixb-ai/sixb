import type { BrokerRetention, BrokerStreamDefinition } from "@sixb/core"
import { RedisBrokerError } from "./errors"

export interface NormalizedRetention {
  readonly maxAgeMs?: number
  readonly maxRecords?: number
  readonly maxBytes?: number
}

export function assertStream(stream: BrokerStreamDefinition): void {
  if (stream.id.trim().length === 0) {
    throw new RedisBrokerError("stream.id must be a non-empty string")
  }
}

export function normalizeRetention(retention: BrokerRetention | undefined): NormalizedRetention {
  return {
    maxAgeMs: retention?.maxAgeMs === undefined ? undefined : Math.max(0, retention.maxAgeMs),
    maxRecords: retention?.maxRecords === undefined ? undefined : Math.max(0, retention.maxRecords),
    maxBytes: retention?.maxBytes === undefined ? undefined : Math.max(0, retention.maxBytes),
  }
}
