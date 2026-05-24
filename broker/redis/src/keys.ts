import { RedisBrokerError } from "./errors"

export interface RedisStreamKeys {
  readonly streamKey: string
  readonly metaKey: string
  dedupeKey(idempotencyKey: string | undefined): string
}

const DEFAULT_DEDUPE_TOKEN = "_"

export function assertPrefix(prefix: string): void {
  if (prefix.trim().length === 0) {
    throw new RedisBrokerError("prefix must be a non-empty string")
  }
  if (/[{}]/.test(prefix)) {
    throw new RedisBrokerError("prefix must not contain Redis hash-tag braces")
  }
}

export function validateProjectId(projectId: string): void {
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new RedisBrokerError("projectId must be a non-empty string")
  }
}

export function assertStreamId(streamId: string): void {
  if (streamId.trim().length === 0) {
    throw new RedisBrokerError("streamId must be a non-empty string")
  }
}

export function streamKeysFor(
  prefix: string,
  projectId: string,
  streamId: string
): RedisStreamKeys {
  // Keep every key for one logical broker stream in a hash-tag-compatible group.
  // The append Lua script touches stream/meta/dedupe keys together.
  const hashTag = `${encodeKeyPart(projectId)}:${encodeKeyPart(streamId)}`
  const base = `${prefix}:brk:{${hashTag}}`

  return {
    streamKey: `${base}:stream`,
    metaKey: `${base}:meta`,
    dedupeKey(idempotencyKey) {
      return `${base}:dedupe:${encodeKeyPart(idempotencyKey ?? DEFAULT_DEDUPE_TOKEN)}`
    },
  }
}

export function encodeKeyPart(value: string): string {
  // Project ids, stream ids, and idempotency keys are user-controlled. Encoding
  // keeps Redis keys readable enough while avoiding accidental separators.
  return Buffer.from(value, "utf8").toString("base64url")
}
