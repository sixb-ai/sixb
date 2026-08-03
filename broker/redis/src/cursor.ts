import { redisBrokerError } from "./errors"

export interface ParsedStreamId {
  readonly milliseconds: bigint
  readonly sequence: bigint
}

const STREAM_ID_PATTERN = /^(\d+)-(\d+)$/

export function assertCursor(cursor: string | undefined): void {
  if (cursor === undefined) {
    return
  }
  parseStreamId(cursor)
}

export function compareStreamIds(left: string, right: string): number {
  // Redis stream ids are timestamp-sequence pairs, not dense integers. Compare
  // both components directly instead of trying to increment or parse as a
  // single number.
  const parsedLeft = parseStreamId(left)
  const parsedRight = parseStreamId(right)

  if (parsedLeft.milliseconds < parsedRight.milliseconds) {
    return -1
  }
  if (parsedLeft.milliseconds > parsedRight.milliseconds) {
    return 1
  }
  if (parsedLeft.sequence < parsedRight.sequence) {
    return -1
  }
  if (parsedLeft.sequence > parsedRight.sequence) {
    return 1
  }
  return 0
}

function parseStreamId(cursor: string): ParsedStreamId {
  const match = STREAM_ID_PATTERN.exec(cursor)
  if (!match) {
    throw redisBrokerError("cursor must be a Redis stream id cursor")
  }

  return {
    milliseconds: BigInt(match[1]!),
    sequence: BigInt(match[2]!),
  }
}
