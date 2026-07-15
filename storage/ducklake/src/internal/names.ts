import { LakeStorageError } from "@sixb/core/lake-storage"

/**
 * Prefix used for all Sixb dataset tables inside the DuckLake schema.
 */
export const DATASET_TABLE_PREFIX = "sixb__ds__"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

function isInlineByte(byte: number): boolean {
  return (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
}

function isHexPair(value: string): boolean {
  return /^[0-9a-f]{2}$/.test(value)
}

/**
 * Encode a Sixb dataset id into a SQL identifier-safe table suffix.
 *
 * Common lowercase dotted ids stay readable by mapping "." to "__". Literal
 * underscores and all other non-inline UTF-8 bytes are encoded as "_xx" hex
 * escapes so decoding is collision-free.
 */
function encodeDatasetId(datasetId: string): string {
  if (datasetId.trim().length === 0) {
    throw new LakeStorageError("[SixbDuckLake] Dataset id must not be empty.")
  }

  let encoded = ""
  for (const byte of textEncoder.encode(datasetId)) {
    if (isInlineByte(byte)) {
      encoded += String.fromCharCode(byte)
    } else if (byte === 0x2e) {
      encoded += "__"
    } else {
      encoded += `_${byte.toString(16).padStart(2, "0")}`
    }
  }

  return encoded
}

/**
 * Decode a table suffix created by `encodeDatasetId`.
 *
 * Returns null for malformed provider table names so metadata scans can filter
 * defensively instead of throwing on unrelated tables.
 */
function decodeDatasetId(encoded: string): string | null {
  if (encoded.length === 0) {
    return null
  }

  const bytes: number[] = []
  let index = 0

  while (index < encoded.length) {
    const char = encoded[index]
    const byte = char.charCodeAt(0)

    if (isInlineByte(byte)) {
      bytes.push(byte)
      index += 1
      continue
    }

    if (char !== "_") {
      return null
    }

    if (encoded[index + 1] === "_") {
      bytes.push(0x2e)
      index += 2
      continue
    }

    const hex = encoded.slice(index + 1, index + 3)
    if (!isHexPair(hex)) {
      return null
    }

    bytes.push(Number.parseInt(hex, 16))
    index += 3
  }

  try {
    return textDecoder.decode(new Uint8Array(bytes))
  } catch {
    return null
  }
}

/**
 * Convert a Sixb dataset id to its physical DuckLake table name.
 */
export function encodeDatasetTableName(datasetId: string): string {
  return `${DATASET_TABLE_PREFIX}${encodeDatasetId(datasetId)}`
}

/**
 * Decode a physical DuckLake table name back to a Sixb dataset id.
 */
export function decodeDatasetTableName(tableName: string): string | null {
  if (!tableName.startsWith(DATASET_TABLE_PREFIX)) {
    return null
  }

  return decodeDatasetId(tableName.slice(DATASET_TABLE_PREFIX.length))
}
