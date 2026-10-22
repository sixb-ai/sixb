// The Gateway's image and speech protocols return base64 without a media type, so the binding
// identifies the format from the file signature. Unknown bytes stay unknown.

export function imageMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp"
  if (ascii(bytes, 4, "ftypavif")) return "image/avif"
  return undefined
}

export function audioMediaType(bytes: Uint8Array): string | undefined {
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav"
  if (ascii(bytes, 0, "OggS")) return "audio/ogg"
  if (ascii(bytes, 0, "fLaC")) return "audio/flac"
  if (ascii(bytes, 0, "ID3")) return "audio/mpeg"
  // An MPEG audio frame sync; ADTS AAC shares the sync but sets layer bits to zero.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return (bytes[1]! & 0x06) === 0 ? "audio/aac" : "audio/mpeg"
  }
  return undefined
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
}
