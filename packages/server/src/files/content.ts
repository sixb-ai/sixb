import {
  type BlobInfo,
  type BlobStorage,
  BlobStorageError,
  type FileRef,
  isFileRef,
  supportsRangeRead,
} from "@sixb/core"

export type FileContentDisposition = "inline" | "attachment"

export interface FileContentResponseInput {
  readonly blobStorage: BlobStorage
  readonly fileRef: FileRef
  readonly disposition?: FileContentDisposition
  readonly head?: boolean
  readonly rangeHeader?: string | null
}

export async function createFileContentResponse(
  input: FileContentResponseInput
): Promise<Response | null> {
  const stat = await input.blobStorage.stat(input.fileRef.blobId)
  if (!stat || !blobMatchesFileRef(stat, input.fileRef)) {
    return null
  }

  const canReadRange = supportsRangeRead(input.blobStorage)
  const headers = fileContentHeaders(input.fileRef, stat, input.disposition, canReadRange)
  if (canReadRange && input.rangeHeader) {
    const range = parseSingleByteRange(input.rangeHeader, stat.sizeBytes)
    if (!range) {
      return rangeNotSatisfiableResponse(stat.sizeBytes)
    }

    const partialHeaders = partialFileContentHeaders(headers, range, stat.sizeBytes)
    if (input.head) {
      return new Response(null, { status: 206, headers: partialHeaders })
    }

    try {
      const stream = await input.blobStorage.openRange(input.fileRef.blobId, range)
      return new Response(stream, { status: 206, headers: partialHeaders })
    } catch (error) {
      if (error instanceof BlobStorageError) {
        return null
      }

      throw error
    }
  }

  if (input.head) {
    return new Response(null, { headers })
  }

  try {
    const stream = await input.blobStorage.open(input.fileRef.blobId)
    return new Response(stream, { headers })
  } catch (error) {
    if (error instanceof BlobStorageError) {
      return null
    }

    throw error
  }
}

export function resolveFileRefAtPath(root: unknown, path: string): FileRef | null {
  const value = resolveJsonPointer(root, path)
  return isFileRef(value) ? value : null
}

function blobMatchesFileRef(stat: BlobInfo, fileRef: FileRef): boolean {
  return (
    stat.blobId === fileRef.blobId &&
    stat.digest === fileRef.digest &&
    stat.sizeBytes === fileRef.sizeBytes
  )
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") {
    return root
  }

  if (!pointer.startsWith("/")) {
    return undefined
  }

  let current = root
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(rawSegment)
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index) || index < 0 || index.toString() !== segment) {
        return undefined
      }
      current = current[index]
      continue
    }

    if (typeof current !== "object" || current === null || !(segment in current)) {
      return undefined
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~")
}

function fileContentHeaders(
  fileRef: FileRef,
  stat: BlobInfo,
  requestedDisposition: FileContentDisposition | undefined,
  canReadRange: boolean
): Headers {
  const mediaType = fileRef.mediaType?.trim() || "application/octet-stream"
  const disposition =
    (requestedDisposition ?? "inline") === "inline" && canRenderInline(mediaType)
      ? "inline"
      : "attachment"
  const headers = new Headers()
  headers.set("content-type", mediaType)
  headers.set("content-length", stat.sizeBytes.toString())
  headers.set("content-disposition", contentDispositionHeader(disposition, fileNameFor(fileRef)))
  headers.set("etag", `"${fileRef.digest}"`)
  headers.set("x-content-type-options", "nosniff")
  if (canReadRange) {
    headers.set("accept-ranges", "bytes")
  }
  return headers
}

interface ParsedByteRange {
  readonly start: number
  readonly endInclusive: number
}

function parseSingleByteRange(header: string, sizeBytes: number): ParsedByteRange | null {
  const normalized = header.trim()
  if (!normalized.startsWith("bytes=") || normalized.includes(",")) {
    return null
  }

  if (sizeBytes <= 0) {
    return null
  }

  const spec = normalized.slice("bytes=".length).trim()
  const match = spec.match(/^(\d*)-(\d*)$/)
  if (!match) {
    return null
  }

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) {
    return null
  }

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null
    }

    return {
      start: Math.max(sizeBytes - suffixLength, 0),
      endInclusive: sizeBytes - 1,
    }
  }

  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start >= sizeBytes) {
    return null
  }

  const requestedEnd = rawEnd ? Number(rawEnd) : sizeBytes - 1
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return null
  }

  return {
    start,
    endInclusive: Math.min(requestedEnd, sizeBytes - 1),
  }
}

function partialFileContentHeaders(
  baseHeaders: Headers,
  range: ParsedByteRange,
  sizeBytes: number
): Headers {
  const headers = new Headers(baseHeaders)
  headers.set("content-length", (range.endInclusive - range.start + 1).toString())
  headers.set("content-range", `bytes ${range.start}-${range.endInclusive}/${sizeBytes}`)
  return headers
}

function rangeNotSatisfiableResponse(sizeBytes: number): Response {
  const headers = new Headers()
  headers.set("accept-ranges", "bytes")
  headers.set("content-range", `bytes */${sizeBytes}`)
  return new Response(null, { status: 416, headers })
}

function canRenderInline(mediaType: string): boolean {
  const baseType = mediaType.split(";")[0]?.trim().toLowerCase()
  if (!baseType) {
    return false
  }

  if (
    baseType === "text/html" ||
    baseType === "image/svg+xml" ||
    baseType === "application/xhtml+xml"
  ) {
    return false
  }

  return (
    baseType === "application/pdf" ||
    baseType === "text/plain" ||
    baseType === "text/markdown" ||
    baseType === "application/json" ||
    baseType.startsWith("image/")
  )
}

function fileNameFor(fileRef: FileRef): string {
  const fromFileName = fileRef.fileName?.split(/[\\/]/).filter(Boolean).at(-1)
  if (fromFileName) {
    return fromFileName
  }

  const fromLogicalPath = fileRef.logicalPath?.split(/[\\/]/).filter(Boolean).at(-1)
  return fromLogicalPath || `${fileRef.blobId}.bin`
}

function contentDispositionHeader(disposition: FileContentDisposition, fileName: string): string {
  const asciiFileName = fileName.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "'")
  return `${disposition}; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
