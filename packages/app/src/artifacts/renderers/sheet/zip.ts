/** One file of an archive, at its path inside it. */
export interface ZipEntry {
  readonly path: string
  readonly data: Uint8Array
}

/**
 * A ZIP archive of the entries, each deflated where the browser can (`CompressionStream` with
 * `deflate-raw`), else stored. Enough of the format for an `.xlsx`: no directories, comments,
 * encryption, or ZIP64, so each entry and the whole stay under 4 GB.
 */
export async function zipFiles(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const crc = crc32(entry.data)
    const deflated = await deflateRaw(entry.data)
    const compressed = deflated && deflated.length < entry.data.length ? deflated : null
    const body = compressed ?? entry.data
    const method = compressed ? 8 : 0

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // version needed: 2.0
    local.setUint16(6, 0x0800, true) // names are UTF-8
    local.setUint16(8, method, true)
    local.setUint16(10, 0, true) // time
    local.setUint16(12, DOS_DATE, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, body.length, true)
    local.setUint32(22, entry.data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), name, body)

    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true)
    header.setUint16(4, 20, true) // made by
    header.setUint16(6, 20, true) // version needed
    header.setUint16(8, 0x0800, true)
    header.setUint16(10, method, true)
    header.setUint16(12, 0, true)
    header.setUint16(14, DOS_DATE, true)
    header.setUint32(16, crc, true)
    header.setUint32(20, body.length, true)
    header.setUint32(24, entry.data.length, true)
    header.setUint16(28, name.length, true)
    header.setUint32(42, offset, true)
    central.push(new Uint8Array(header.buffer), name)

    offset += 30 + name.length + body.length
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  return concat([...parts, ...central, new Uint8Array(end.buffer)])
}

/** 1980-01-01, the format's first day: the archive's files carry no time of their own. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== "function") return null
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    // An engine without deflate-raw stores the entry instead.
    return null
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
