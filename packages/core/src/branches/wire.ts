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
  /** The branch's credential: it reads production only as its person, only for the branch. */
  readonly credential: string
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
  // Chunks wait in a queue, and each part copies only its own bytes out of it: a part may be
  // hundreds of megabytes, and a chunk may hold thousands of small parts.
  const chunks: Uint8Array[] = []
  let offset = 0
  let length = 0
  const read = (count: number, consume: boolean): Uint8Array => {
    const out = new Uint8Array(count)
    let copied = 0
    let index = 0
    let at = offset
    while (copied < count) {
      const chunk = chunks[index]!
      const take = Math.min(count - copied, chunk.length - at)
      out.set(chunk.subarray(at, at + take), copied)
      copied += take
      at += take
      if (at === chunk.length) {
        index += 1
        at = 0
      }
    }
    if (consume) {
      chunks.splice(0, index)
      offset = at
      length -= count
    }
    return out
  }

  for await (const chunk of stream) {
    if (chunk.length === 0) continue
    chunks.push(chunk)
    length += chunk.length

    while (length >= HEADER_BYTES) {
      const header = read(HEADER_BYTES, false)
      const size = new DataView(header.buffer).getUint32(1, true)
      if (length < HEADER_BYTES + size) break

      read(HEADER_BYTES, true)
      yield { kind: header[0]!, bytes: read(size, true) }
    }
  }

  if (length > 0) throw incomplete()
}

function incomplete(): Error {
  return new Error(
    "[Sixb] The copy from production ended before it was complete. Run `sixb dev --from production --refresh` again."
  )
}
