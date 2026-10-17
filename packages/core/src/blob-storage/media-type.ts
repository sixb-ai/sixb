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
 * none this function knows. Only formats with an unambiguous signature are recognized; text formats
 * have none and are left to the file name.
 */
export function sniffFileMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif"
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp"
  if (asciiAt(bytes, 0, "%PDF-")) return "application/pdf"
  return undefined
}

/**
 * The media type of a file handed over without one: its bytes' signature when they have one, else
 * its extension, else `application/octet-stream`. Every place that classifies a sandbox or tool file
 * goes through this one table, so the same file gets the same type wherever it comes from.
 */
export function inferFileMediaType(fileName: string, bytes?: Uint8Array): string {
  const sniffed = bytes === undefined ? undefined : sniffFileMediaType(bytes)
  if (sniffed) return sniffed
  const dot = fileName.lastIndexOf(".")
  const extension = dot < 0 ? "" : fileName.slice(dot).toLowerCase()
  return EXTENSION_MEDIA_TYPES[extension] ?? "application/octet-stream"
}

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".markdown": "text/markdown",
  ".md": "text/markdown",
  ".mjs": "application/javascript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
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
