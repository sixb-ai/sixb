import { promisify } from "node:util"
import { zstdCompress, zstdDecompress } from "node:zlib"
import type { JsonValue } from "../json"
import type { UserRef } from "../ontology/user-ref"
import type { GroupMembershipSource, UserStatus } from "../storage/auth"

/**
 * A snapshot is a stream of frames after an 8-byte signature. Each frame is a 4-byte little-endian
 * payload length, a 1-byte codec, and one JSON record: plain (codec 0) or zstd-compressed (1).
 * Every frame decodes on its own, so the stream is read as it arrives, and the `end` record tells
 * a complete stream from a cut one.
 *
 * Objects are columnar: one array per property across a page, which compresses to about half of
 * one JSON object per row and decodes faster.
 */
export const SNAPSHOT_SIGNATURE = new Uint8Array([0x53, 0x49, 0x58, 0x42, 0x53, 0x4e, 0x50, 0x01])

/**
 * The format's version, in the signature's last byte and in the manifest. A reader refuses any
 * other: a new record kind, such as a projection's source rows, comes with the next version.
 */
export const SNAPSHOT_FORMAT = 1

const FRAME_HEADER_BYTES = 5
const MAX_FRAME_BYTES = 512 * 1024 * 1024
const CODEC_JSON = 0
const CODEC_ZSTD = 1

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)

export type SnapshotRecord =
  | SnapshotManifest
  | SnapshotMembers
  | SnapshotObjects
  | SnapshotLinks
  | SnapshotPoints
  | SnapshotVectors
  | SnapshotEnd

/** What the snapshot holds, written first. */
export interface SnapshotManifest {
  readonly kind: "manifest"
  readonly format: typeof SNAPSHOT_FORMAT
  readonly projectId: string
  /** S, the moment the consistent read began. */
  readonly takenAt: string
  readonly takenBy: UserRef
  /** Every member and group, or only the person and their groups. */
  readonly members: "all" | "self"
  readonly types: readonly SnapshotTypeManifest[]
  /** Object types the person cannot read: nothing of theirs is in the snapshot. */
  readonly unreadableTypeIds: readonly string[]
  /**
   * The lake catalog's point at S, so the objects and the lake slice a branch reads describe the
   * same moment. Present when the export cut a slice (`lake` option).
   */
  readonly lake?: { readonly catalogVersion: string }
}

/** One object type as production defines it, so the importer can tell what still fits. */
export interface SnapshotTypeManifest {
  readonly objectTypeId: string
  readonly primaryPropertyId: string
  /** Fingerprint of each property's definition, by property id. */
  readonly properties: Readonly<Record<string, string>>
  readonly requiredPropertyIds: readonly string[]
  readonly uniquePropertyIds: readonly string[]
  /** Fingerprint of each link's definition, by link id. */
  readonly links: Readonly<Record<string, string>>
  /** Properties the person's clearance hides: their values are not in the snapshot. */
  readonly hiddenPropertyIds: readonly string[]
  readonly throughCondition: boolean
  /** The vector profiles whose values the snapshot carries, with production's configuration. */
  readonly vectors: readonly { readonly profile: string; readonly configuration: string }[]
  /** The projection that feeds the type, and the dataset version production applied. */
  readonly projection?: SnapshotProjection
}

export interface SnapshotProjection {
  readonly projectionId: string
  readonly datasetId: string
  /**
   * Whether the person holds `dataset.view` on the projection's dataset. It is not "reads the
   * dataset in full": a column's markings may still hide it, which the lake slice decides.
   */
  readonly datasetView: boolean
  readonly applied?: {
    readonly datasetVersionId: string
    readonly projectionRevision: string
  }
}

export interface SnapshotMembers {
  readonly kind: "members"
  /**
   * `[id, email, displayName, avatarUrl, status, createdAt, updatedAt]`. Why a member is suspended
   * stays in production: a branch has no directory, so a suspended member is suspended by hand.
   */
  readonly users: readonly (readonly [
    string,
    string,
    string | null,
    string | null,
    UserStatus,
    number,
    number,
  ])[]
  /** `[userId, groupId, source, createdAt]`. */
  readonly memberships: readonly (readonly [string, string, GroupMembershipSource, number])[]
}

/** One page of one object type. Times are epoch milliseconds. */
export interface SnapshotObjects {
  readonly kind: "objects"
  readonly objectTypeId: string
  readonly ids: readonly string[]
  readonly createdAt: readonly number[]
  readonly updatedAt: readonly number[]
  /** Property ids, each with its values; `rows` lists the rows holding one when not all do. */
  readonly columns: readonly SnapshotColumn[]
}

export interface SnapshotColumn {
  readonly propertyId: string
  readonly values: readonly JsonValue[]
  readonly rows?: readonly number[]
}

/** Links from one page of objects: `[sourceId, linkId, targetTypeId, targetId, createdAt, updatedAt, properties]`. */
export interface SnapshotLinks {
  readonly kind: "links"
  readonly sourceTypeId: string
  readonly rows: readonly (readonly [
    string,
    string,
    string,
    string,
    number,
    number,
    Readonly<Record<string, JsonValue>> | null,
  ])[]
}

/** Latest telemetry values: `[objectId, propertyId, value, unit, at]`. */
export interface SnapshotPoints {
  readonly kind: "points"
  readonly objectTypeId: string
  readonly rows: readonly (readonly [string, string, JsonValue, string | null, number])[]
}

/** Vectors of one profile: float32 little-endian values, `dimensions` per object, in base64. */
export interface SnapshotVectors {
  readonly kind: "vectors"
  readonly objectTypeId: string
  readonly profile: string
  readonly configuration: string
  readonly source: readonly string[]
  readonly dimensions: number
  readonly ids: readonly string[]
  readonly sourceFingerprints: readonly string[]
  readonly values: string
}

export interface SnapshotEnd {
  readonly kind: "end"
  readonly counts: SnapshotCounts
}

export interface SnapshotCounts {
  readonly objects: number
  readonly links: number
  readonly points: number
  readonly vectors: number
  readonly users: number
}

/** A record past the frame limit: the writer splits its rows and encodes each half. */
export class SnapshotFrameTooLarge extends Error {
  constructor() {
    super(`[Sixb] A snapshot frame may hold at most ${MAX_FRAME_BYTES} bytes.`)
  }
}

export async function encodeSnapshotFrame(
  record: SnapshotRecord,
  options: { readonly compress: boolean }
): Promise<Uint8Array> {
  const json = Buffer.from(JSON.stringify(record))
  if (json.length > MAX_FRAME_BYTES) throw new SnapshotFrameTooLarge()

  const payload = options.compress ? await compress(json) : json

  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length)
  new DataView(frame.buffer).setUint32(0, payload.length, true)
  frame[4] = options.compress ? CODEC_ZSTD : CODEC_JSON
  frame.set(payload, FRAME_HEADER_BYTES)

  return frame
}

/** Decode a snapshot stream into its records, refusing anything but a complete snapshot. */
export async function* decodeSnapshot(
  stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
): AsyncGenerator<SnapshotRecord> {
  const pending = new ByteQueue()
  let signed = false
  let ended = false

  for await (const chunk of stream) {
    pending.push(chunk)

    if (!signed) {
      if (pending.length < SNAPSHOT_SIGNATURE.length) continue
      assertSignature(pending.take(SNAPSHOT_SIGNATURE.length))
      signed = true
    }

    while (pending.length >= FRAME_HEADER_BYTES) {
      const header = pending.peek(FRAME_HEADER_BYTES)
      const length = new DataView(header.buffer, header.byteOffset).getUint32(0, true)
      if (length > MAX_FRAME_BYTES) throw corrupt(`a frame claims ${length} bytes`)
      if (pending.length < FRAME_HEADER_BYTES + length) break

      pending.take(FRAME_HEADER_BYTES)
      const payload = pending.take(length)
      if (ended) throw corrupt("frames follow its end")

      const record = await decodePayload(header[4], payload)
      if (record.kind === "end") ended = true
      yield record
    }
  }

  if (!signed || pending.length > 0 || !ended) {
    throw new Error(
      "[Sixb] The snapshot is incomplete: it ends before its last frame. Take or download it again."
    )
  }
}

/** Bytes as they arrive, read from the front without copying what has not been asked for. */
class ByteQueue {
  #chunks: Uint8Array[] = []
  #offset = 0
  length = 0

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.#chunks.push(chunk)
    this.length += chunk.length
  }

  peek(count: number): Uint8Array {
    const first = this.#chunks[0]
    if (first && first.length - this.#offset >= count) {
      return first.subarray(this.#offset, this.#offset + count)
    }
    return this.#copy(count, false)
  }

  take(count: number): Uint8Array {
    const taken = this.#copy(count, true)
    this.length -= count
    return taken
  }

  #copy(count: number, consume: boolean): Uint8Array {
    const first = this.#chunks[0]
    if (consume && first && first.length - this.#offset >= count) {
      const slice = first.subarray(this.#offset, this.#offset + count)
      this.#advance(count)
      return slice
    }

    const out = new Uint8Array(count)
    let written = 0
    let index = 0
    let offset = this.#offset
    while (written < count) {
      const chunk = this.#chunks[index]!
      const part = chunk.subarray(offset, offset + count - written)
      out.set(part, written)
      written += part.length
      index += 1
      offset = 0
    }
    if (consume) this.#advance(count)
    return out
  }

  #advance(count: number): void {
    let left = count
    while (left > 0) {
      const first = this.#chunks[0]!
      const available = first.length - this.#offset
      if (available > left) {
        this.#offset += left
        return
      }
      left -= available
      this.#chunks.shift()
      this.#offset = 0
    }
  }
}

async function decodePayload(codec: number | undefined, payload: Uint8Array) {
  if (codec !== CODEC_JSON && codec !== CODEC_ZSTD) throw corrupt(`unknown codec ${codec}`)

  const json = codec === CODEC_ZSTD ? await decompress(payload) : payload
  const record = JSON.parse(Buffer.from(json.buffer, json.byteOffset, json.length).toString())
  if (typeof record !== "object" || record === null || typeof record.kind !== "string") {
    throw corrupt("a frame holds no record")
  }

  return record as SnapshotRecord
}

function assertSignature(buffer: Uint8Array): void {
  for (let index = 0; index < SNAPSHOT_SIGNATURE.length - 1; index += 1) {
    if (buffer[index] !== SNAPSHOT_SIGNATURE[index]) throw corrupt("it is not a Sixb snapshot")
  }

  const version = buffer[SNAPSHOT_SIGNATURE.length - 1]
  if (version !== SNAPSHOT_FORMAT) {
    throw new Error(
      `[Sixb] This snapshot uses format ${version}; this version of Sixb reads format ${SNAPSHOT_FORMAT}. Take it again with the same Sixb version on both sides.`
    )
  }
}

function corrupt(why: string): Error {
  return new Error(`[Sixb] The snapshot cannot be read: ${why}.`)
}

/** A value storage returned, which a snapshot carries as JSON: refused when it is not. */
export function jsonOf(value: unknown): JsonValue {
  if (isJson(value)) return value
  throw notJson()
}

/** Properties storage returned, as a snapshot carries them. */
export function jsonRecordOf(value: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  const record: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) record[key] = jsonOf(item)
  return record
}

function notJson(): Error {
  return new Error("[Sixb] A snapshot carries JSON values only: storage returned another value.")
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.values(value).every(isJson)
}

/** Columns of a page of property bags, each value listed once with the rows that hold one. */
export function toColumns(rows: readonly Readonly<Record<string, unknown>>[]): SnapshotColumn[] {
  const columns = new Map<string, { values: JsonValue[]; rows: number[] }>()

  rows.forEach((properties, row) => {
    for (const propertyId in properties) {
      const value = properties[propertyId]
      if (value === undefined) continue

      let column = columns.get(propertyId)
      if (!column) {
        column = { values: [], rows: [] }
        columns.set(propertyId, column)
      }
      column.values.push(value as JsonValue)
      column.rows.push(row)
    }
  })

  return [...columns].map(([propertyId, column]) =>
    column.rows.length === rows.length
      ? { propertyId, values: column.values }
      : { propertyId, values: column.values, rows: column.rows }
  )
}

/** The property bags of a page of objects, back from its columns. */
export function fromColumns(record: SnapshotObjects): Record<string, JsonValue>[] {
  const rows = record.ids.map((): Record<string, JsonValue> => ({}))

  for (const column of record.columns) {
    const { propertyId, values } = column
    if (column.rows === undefined) {
      for (let index = 0; index < values.length; index += 1) {
        rows[index]![propertyId] = values[index]!
      }
    } else {
      for (let index = 0; index < values.length; index += 1) {
        rows[column.rows[index]!]![propertyId] = values[index]!
      }
    }
  }

  return rows
}
