// One media type as RFC 9110 defines it: `type/subtype`, each a token, then optional
// `;name=value` parameters whose value is a token or a quoted string. Stricter than the RFC where
// leniency only invites a second reading: no surrounding whitespace, no empty parameters, no
// escapes, and no comma anywhere. Browsers read a comma-separated value as a list of types and
// use the last valid one, so a value with a comma can mean something other than its first type.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"
const QUOTED_STRING = '"[\\t\\x20\\x21\\x23-\\x2b\\x2d-\\x5b\\x5d-\\x7e]*"'
const PARAMETER = `[\\t ]*;[\\t ]*(${TOKEN})=(${TOKEN}|${QUOTED_STRING})`
const MEDIA_TYPE_PATTERN = new RegExp(`^(${TOKEN})/(${TOKEN})((?:${PARAMETER})*)$`)
const PARAMETER_PATTERN = new RegExp(PARAMETER, "g")

/**
 * The canonical form of a single well-formed media type, or `null` for anything else.
 *
 * Type, subtype, and parameter names are case-insensitive, so they are lowercased; parameter
 * values keep their case. `"Text/Plain; Charset=UTF-8"` becomes `"text/plain;charset=UTF-8"`.
 */
export function canonicalMediaType(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = MEDIA_TYPE_PATTERN.exec(value)
  if (!match) return null

  const [, type, subtype, parameters] = match
  let canonical = `${type.toLowerCase()}/${subtype.toLowerCase()}`
  for (const [, name, parameterValue] of parameters.matchAll(PARAMETER_PATTERN)) {
    canonical += `;${name.toLowerCase()}=${parameterValue}`
  }
  return canonical
}

/**
 * The media type a file's bytes declare by their leading signature, or `undefined` when they carry
 * none this function knows. Only formats with an unambiguous signature are recognized, and MP3 by
 * a frame header whose every field is checked; text formats have none and are left to the file
 * name.
 */
export function sniffFileMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif"
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp"
  if (asciiAt(bytes, 0, "%PDF-")) return "application/pdf"

  if (asciiAt(bytes, 4, "ftyp")) return MP4_BRANDS.get(ascii(bytes, 8, 4))
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]))
    return MATROSKA_DOC_TYPES.get(matroskaDocType(bytes))
  if (asciiAt(bytes, 0, "OggS")) return oggMediaType(bytes)
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE")) return "audio/wav"
  if (asciiAt(bytes, 0, "fLaC")) return "audio/flac"
  if (asciiAt(bytes, 0, "ID3")) return "audio/mpeg"
  return mpegAudioMediaType(bytes)
}

/**
 * The media type of a file handed over without one: its bytes' signature when they have one, else
 * its extension, else `application/octet-stream`. Every place that classifies a sandbox or tool file
 * goes through this one table, so the same file gets the same type wherever it comes from.
 */
export function inferFileMediaType(fileName: string, bytes?: Uint8Array): string {
  const sniffed = bytes === undefined ? undefined : sniffFileMediaType(bytes)
  const dot = fileName.lastIndexOf(".")
  const named = EXTENSION_MEDIA_TYPES[dot < 0 ? "" : fileName.slice(dot).toLowerCase()]

  // A signature names the container; only the name can say that an MP4 or a WebM holds sound alone.
  if (sniffed?.startsWith("video/") && named === `audio/${sniffed.slice("video/".length)}`) {
    return named
  }
  return sniffed ?? named ?? "application/octet-stream"
}

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".markdown": "text/markdown",
  ".md": "text/markdown",
  ".mjs": "application/javascript",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".srt": "application/x-subrip",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".vtt": "text/vtt",
  ".wav": "audio/wav",
  ".weba": "audio/webm",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
}

// An ISO media file opens with an `ftyp` box whose major brand names its family. Only brands that
// say what the file is count: an AVIF or a HEIC image is in the same box format.
const MP4_BRANDS: ReadonlyMap<string, string> = new Map([
  ["avc1", "video/mp4"],
  ["dash", "video/mp4"],
  ["iso2", "video/mp4"],
  ["iso4", "video/mp4"],
  ["iso5", "video/mp4"],
  ["iso6", "video/mp4"],
  ["isom", "video/mp4"],
  ["mp41", "video/mp4"],
  ["mp42", "video/mp4"],
  ["M4V ", "video/mp4"],
  ["M4A ", "audio/mp4"],
  ["M4B ", "audio/mp4"],
  ["qt  ", "video/quicktime"],
])

const MATROSKA_DOC_TYPES: ReadonlyMap<string, string> = new Map([
  ["webm", "video/webm"],
  ["matroska", "video/x-matroska"],
])

/**
 * A Matroska file's DocType, `webm` or `matroska`, from its EBML header: the element `42 82`, its
 * size as a one-byte variable-length integer, then the name. Writers put it in the first bytes.
 */
function matroskaDocType(bytes: Uint8Array): string {
  const head = bytes.subarray(0, 64)
  for (let index = 4; index + 2 < head.byteLength; index += 1) {
    if (head[index] !== 0x42 || head[index + 1] !== 0x82) continue
    // A one-byte size has its top bit set; longer ones never hold a DocType this short.
    const size = head[index + 2] ?? 0
    return size & 0x80 ? ascii(head, index + 3, size & 0x7f) : ""
  }
  return ""
}

/** An Ogg stream's first packet names its codec: Theora is video, Opus, Vorbis, or FLAC sound. */
function oggMediaType(bytes: Uint8Array): string {
  // The first page's 27-byte header, then its segment table, then the packet.
  const packet = 27 + (bytes[26] ?? 0)
  return asciiAt(bytes, packet + 1, "theora") ? "video/ogg" : "audio/ogg"
}

/**
 * MP3, or AAC in ADTS, without an ID3 tag: a frame header, 11 set bits of sync, whose fields must
 * also hold values a real frame can have, so that arbitrary bytes starting with `FF E0` do not pass.
 */
function mpegAudioMediaType(bytes: Uint8Array): string | undefined {
  const [first = 0, second = 0, third = 0] = bytes
  if (bytes.byteLength < 3 || first !== 0xff || (second & 0xe0) !== 0xe0) return undefined

  // ADTS: a 12-bit sync, layer 0, and a sampling frequency index under 13.
  const layer = (second >> 1) & 0b11
  if (layer === 0) {
    return (second & 0xf0) === 0xf0 && ((third >> 2) & 0b1111) < 13 ? "audio/aac" : undefined
  }

  // MP3: layer III, and a version, a bitrate, and a sampling rate that are not the reserved values.
  // Layers I and II are left to the name: `FF FE`, the byte order mark that opens UTF-16 text,
  // reads as a layer I header.
  const version = (second >> 3) & 0b11
  const bitrate = third >> 4
  const sampleRate = (third >> 2) & 0b11
  if (layer !== 0b01 || version === 0b01 || bitrate === 0b1111 || sampleRate === 0b11) {
    return undefined
  }
  return "audio/mpeg"
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}
