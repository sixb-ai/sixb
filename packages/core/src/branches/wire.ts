/**
 * What production sends `sixb dev --from production`, in one response: the snapshot's bytes as
 * they are made, then the lake slice cut at the same moment, which exists only once the snapshot
 * is written. Each part is a 1-byte kind and a 4-byte little-endian length, then its bytes.
 */

const PART_SNAPSHOT = 1
const PART_LAKE_CATALOG = 2
const PART_LAKE = 3
const PART_END = 4
const HEADER_BYTES = 5

/** The lake slice a copy carries: its catalog is written beside the branch's data. */
export interface BranchCopyLake {
  readonly sliceId: string
  readonly point: string
  readonly token: string
  readonly expiresAt: string
}

export function encodeBranchCopyPart(kind: "snapshot" | "catalog", bytes: Uint8Array): Uint8Array
export function encodeBranchCopyPart(kind: "lake", lake: BranchCopyLake): Uint8Array
export function encodeBranchCopyPart(kind: "end"): Uint8Array
export function encodeBranchCopyPart(
  kind: "snapshot" | "catalog" | "lake" | "end",
  value?: Uint8Array | BranchCopyLake
): Uint8Array {
  const payload =
    value === undefined
      ? new Uint8Array()
      : value instanceof Uint8Array
        ? value
        : new TextEncoder().encode(JSON.stringify(value))
  const code = {
    snapshot: PART_SNAPSHOT,
    catalog: PART_LAKE_CATALOG,
    lake: PART_LAKE,
    end: PART_END,
  }[kind]

  const part = new Uint8Array(HEADER_BYTES + payload.length)
  part[0] = code
  new DataView(part.buffer).setUint32(1, payload.length, true)
  part.set(payload, HEADER_BYTES)
  return part
}

export interface BranchCopyReader {
  /** The snapshot's bytes, which end where the lake parts begin. */
  readonly snapshot: AsyncIterable<Uint8Array>
  /** Once the snapshot is read: the lake slice and its catalog, or null without one. */
  rest(): Promise<{ readonly lake: BranchCopyLake; readonly catalog: Uint8Array } | null>
}

/** Split a copy's response into its snapshot and the lake slice that follows it. */
export function readBranchCopy(stream: AsyncIterable<Uint8Array>): BranchCopyReader {
  const parts = readParts(stream)
  let pending: { readonly kind: number; readonly bytes: Uint8Array } | undefined

  async function* snapshot(): AsyncGenerator<Uint8Array> {
    for (let next = await parts.next(); !next.done; next = await parts.next()) {
      if (next.value.kind !== PART_SNAPSHOT) {
        pending = next.value
        return
      }
      yield next.value.bytes
    }
    throw incomplete()
  }

  return {
    snapshot: snapshot(),
    async rest() {
      const catalog: Uint8Array[] = []
      let lake: BranchCopyLake | undefined

      for (let part = pending ?? (await nextPart(parts)); ; part = await nextPart(parts)) {
        if (part.kind === PART_END) break
        if (part.kind === PART_LAKE_CATALOG) catalog.push(part.bytes)
        else if (part.kind === PART_LAKE) {
          lake = JSON.parse(new TextDecoder().decode(part.bytes)) as BranchCopyLake
        } else throw incomplete()
      }

      return lake ? { lake, catalog: Buffer.concat(catalog) } : null
    },
  }
}

async function nextPart(
  parts: AsyncGenerator<{ readonly kind: number; readonly bytes: Uint8Array }>
): Promise<{ readonly kind: number; readonly bytes: Uint8Array }> {
  const next = await parts.next()
  if (next.done) throw incomplete()
  return next.value
}

async function* readParts(
  stream: AsyncIterable<Uint8Array>
): AsyncGenerator<{ readonly kind: number; readonly bytes: Uint8Array }> {
  // Chunks are joined only once a whole part has arrived: a part may be hundreds of megabytes.
  const chunks: Uint8Array[] = []
  let length = 0
  const take = (count: number): Uint8Array => {
    const joined = Buffer.concat(chunks, length)
    chunks.length = 0
    chunks.push(joined.subarray(count))
    length -= count
    return joined.subarray(0, count)
  }

  for await (const chunk of stream) {
    chunks.push(chunk)
    length += chunk.length

    while (length >= HEADER_BYTES) {
      const header = chunks[0]!.length >= HEADER_BYTES ? chunks[0]! : Buffer.concat(chunks, length)
      const size = new DataView(header.buffer, header.byteOffset).getUint32(1, true)
      if (length < HEADER_BYTES + size) break

      const part = take(HEADER_BYTES + size)
      yield { kind: part[0]!, bytes: part.slice(HEADER_BYTES) }
    }
  }

  if (length > 0) throw incomplete()
}

function incomplete(): Error {
  return new Error(
    "[Sixb] The copy from production ended before it was complete. Run `sixb dev --from production --refresh` again."
  )
}
