import { type BlobInfo, type BlobStorage, type FileRef, isFileRef } from "@sixb/core"
import { BlobStorageError, supportsRangeRead } from "@sixb/core/blob-storage/server"
import { ZodError } from "zod"

export type FileContentDisposition = "inline" | "attachment"

export interface FileContentResponseInput {
  readonly blobStorage: BlobStorage
  readonly fileRef: FileRef
  readonly disposition?: FileContentDisposition
  readonly head?: boolean
  readonly rangeHeader?: string | null
}

export interface FileContentQuery {
  readonly path: string
  readonly disposition?: FileContentDisposition
}

export interface ContextualFileContentResponseInput<TQuery extends FileContentQuery> {
  readonly blobStorage: BlobStorage
  readonly query: unknown
  readonly querySchema: { parse(value: unknown): TQuery }
  readonly request: Request
  readonly set: { status?: number | string }
  readonly head?: boolean
  readonly resolveRoot: (query: TQuery) => Promise<unknown | null | undefined> | unknown | null
  readonly hideError?: (error: unknown) => boolean
  readonly missingMessage?: string
  readonly invalidQueryMessage?: string
}

/**
 * Declared only by routes whose content lives behind an optional storage role
 * (action runs, workflow runs, agent messages). Object file content is not one of
 * them — object storage is mandatory — so this stays opt-in rather than being
 * folded into the shared shape, or the schema would promise a status those routes
 * can never return.
 */
const unconfiguredStorageResponse = {
  501: {
    description: "The storage role backing this content is not configured",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" },
      },
    },
  },
} as const

export interface FileContentResponsesOptions {
  /** Add the 501 the route returns when its storage role is absent. */
  readonly optionalStorage?: boolean
}

export function fileContentGetResponses(options: FileContentResponsesOptions = {}) {
  return {
    200: {
      description: "File content",
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    },
    206: {
      description: "Partial file content",
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    },
    400: {
      description: "Response for status 400",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
        },
      },
    },
    404: {
      description: "Response for status 404",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
        },
      },
    },
    416: {
      description: "Requested byte range is not satisfiable",
    },
    ...(options.optionalStorage ? unconfiguredStorageResponse : {}),
  } as const
}

export function fileContentHeadResponses(options: FileContentResponsesOptions = {}) {
  return {
    200: {
      description: "File content headers",
    },
    206: {
      description: "Partial file content headers",
    },
    400: {
      description: "Response for status 400",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
        },
      },
    },
    404: {
      description: "Response for status 404",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
        },
      },
    },
    416: {
      description: "Requested byte range is not satisfiable",
    },
    ...(options.optionalStorage ? unconfiguredStorageResponse : {}),
  } as const
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

/**
 * Serve a FileRef only through the record that contains it. Callers authorize the containing
 * context first, then this helper validates the content-addressed FileRef before streaming.
 */
export async function createContextualFileContentResponse<TQuery extends FileContentQuery>(
  input: ContextualFileContentResponseInput<TQuery>
): Promise<Response | { readonly error: string }> {
  const missingMessage = input.missingMessage ?? "File not found"
  const invalidQueryMessage = input.invalidQueryMessage ?? "Invalid file content query"

  try {
    const parsed = input.querySchema.parse(input.query)
    const root = await input.resolveRoot(parsed)
    if (root === null || root === undefined) {
      return fileContentNotFound(input.set, missingMessage)
    }

    const fileRef = resolveFileRefAtPath(root, parsed.path)
    if (!fileRef) {
      return fileContentNotFound(input.set, missingMessage)
    }

    const response = await createFileContentResponse({
      blobStorage: input.blobStorage,
      fileRef,
      disposition: parsed.disposition,
      head: input.head,
      rangeHeader: input.request.headers.get("range"),
    })
    if (!response) {
      return fileContentNotFound(input.set, missingMessage)
    }

    return response
  } catch (error) {
    if (error instanceof ZodError) {
      input.set.status = 400
      return { error: invalidQueryMessage }
    }

    if (input.hideError?.(error)) {
      return fileContentNotFound(input.set, missingMessage)
    }

    throw error
  }
}

export function resolveFileRefAtPath(root: unknown, path: string): FileRef | null {
  const value = resolveJsonPointer(root, path)
  return isFileRef(value) ? value : null
}

function fileContentNotFound(
  set: { status?: number | string },
  message: string
): { readonly error: string } {
  set.status = 404
  return { error: message }
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
      if (!Object.hasOwn(current, segment)) {
        return undefined
      }
      current = current[index]
      continue
    }

    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
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
  // Blobs are content-addressed and immutable, so responses can be cached
  // aggressively — but only privately: reads are grant-enforced and must never
  // land in a shared cache.
  headers.set("cache-control", "private, max-age=31536000, immutable")
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
