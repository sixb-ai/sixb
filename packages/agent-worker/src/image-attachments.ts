export interface AgentAttachmentLimits {
  readonly textInlineMaxBytes: number
  readonly textInlineMaxLines: number
  readonly imageMaxWidth: number
  readonly imageMaxHeight: number
  readonly imageMaxBase64Bytes: number
  readonly imageJpegQualities: readonly number[]
  readonly imageMaxPixels: number
  readonly sandboxFileMaxBytes: number
  readonly sandboxTotalMaxBytes: number
}

export type ProcessedAgentImage =
  | {
      readonly ok: true
      readonly dataUrl: URL
      readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
      readonly width: number
      readonly height: number
      readonly originalWidth: number
      readonly originalHeight: number
      readonly wasResized: boolean
      readonly notes: readonly string[]
    }
  | {
      readonly ok: false
      readonly reason: string
      readonly notes: readonly string[]
    }

interface ImageMetadata {
  readonly width: number
  readonly height: number
  readonly format: string
}

interface ImageCandidate {
  readonly base64: string
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  readonly encodedSize: number
  readonly width: number
  readonly height: number
  readonly convertedFrom?: string
}

const BUN_FORMAT_TO_MEDIA_TYPE: Readonly<Record<string, ImageCandidate["mediaType"]>> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
}

export async function processAgentImageAttachment(input: {
  readonly bytes: Uint8Array
  readonly declaredMediaType?: string
  readonly fileName?: string
  readonly limits: AgentAttachmentLimits
  readonly signal?: AbortSignal
}): Promise<ProcessedAgentImage> {
  const { bytes, limits } = input
  input.signal?.throwIfAborted()
  if (typeof Bun.Image !== "function") {
    return {
      ok: false,
      reason: "Bun.Image is unavailable in this runtime",
      notes: ["[Image not inlined: this Bun runtime does not provide image processing.]"],
    }
  }

  let metadata: ImageMetadata
  try {
    metadata = await readImageMetadata(bytes, limits)
    input.signal?.throwIfAborted()
  } catch (error) {
    input.signal?.throwIfAborted()
    return {
      ok: false,
      reason: imageErrorMessage(error),
      notes: ["[Image omitted: could not be decoded as a supported image format.]"],
    }
  }

  const originalMediaType =
    mediaTypeForFormat(metadata.format) ?? normalizedMediaType(input.declaredMediaType)
  if (!originalMediaType) {
    return {
      ok: false,
      reason: `unsupported image format '${metadata.format}'`,
      notes: ["[Image omitted: unsupported image format.]"],
    }
  }

  const candidates: ImageCandidate[] = []
  const originalBase64Size = base64EncodedSize(bytes.byteLength)
  const withinDimensions =
    metadata.width <= limits.imageMaxWidth && metadata.height <= limits.imageMaxHeight
  if (
    withinDimensions &&
    originalBase64Size < limits.imageMaxBase64Bytes &&
    originalMediaType !== "image/bmp"
  ) {
    const originalCandidate = originalCandidateFor(bytes, metadata, originalMediaType)
    if (originalCandidate) {
      return processedImageFromCandidate(originalCandidate, metadata)
    }
  }

  candidates.push(
    ...(await encodedCandidates(bytes, metadata, originalMediaType, limits, input.signal))
  )
  input.signal?.throwIfAborted()
  const winner = candidates
    .filter((candidate) => candidate.encodedSize < limits.imageMaxBase64Bytes)
    .sort((left, right) => left.encodedSize - right.encodedSize)[0]

  if (!winner) {
    return {
      ok: false,
      reason: "inline image size limit exceeded",
      notes: ["[Image omitted: could not be resized below the inline image size limit.]"],
    }
  }

  return processedImageFromCandidate(winner, metadata)
}

async function readImageMetadata(
  bytes: Uint8Array,
  limits: AgentAttachmentLimits
): Promise<ImageMetadata> {
  const metadata = await new Bun.Image(bytes, {
    maxPixels: limits.imageMaxPixels,
    autoOrient: true,
  }).metadata()
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
  }
}

function originalCandidateFor(
  bytes: Uint8Array,
  metadata: ImageMetadata,
  mediaType: string
): ImageCandidate | undefined {
  if (!isSupportedInlineImageMediaType(mediaType)) {
    return undefined
  }
  return {
    base64: Buffer.from(bytes).toString("base64"),
    mediaType,
    encodedSize: base64EncodedSize(bytes.byteLength),
    width: metadata.width,
    height: metadata.height,
  }
}

async function encodedCandidates(
  bytes: Uint8Array,
  metadata: ImageMetadata,
  originalMediaType: string,
  limits: AgentAttachmentLimits,
  signal?: AbortSignal
): Promise<ImageCandidate[]> {
  const result: ImageCandidate[] = []
  const resized = () =>
    new Bun.Image(bytes, { maxPixels: limits.imageMaxPixels, autoOrient: true }).resize(
      limits.imageMaxWidth,
      limits.imageMaxHeight,
      { fit: "inside", withoutEnlargement: true, filter: "lanczos3" }
    )

  try {
    signal?.throwIfAborted()
    const pngBytes = await resized().png().bytes()
    signal?.throwIfAborted()
    result.push(
      await candidateFromEncodedBytes({
        bytes: pngBytes,
        mediaType: "image/png",
        originalMediaType,
        fallbackWidth: Math.min(metadata.width, limits.imageMaxWidth),
        fallbackHeight: Math.min(metadata.height, limits.imageMaxHeight),
        limits,
      })
    )
  } catch {
    signal?.throwIfAborted()
    // Keep trying JPEG candidates below. The caller reports omission if none fit.
  }

  for (const quality of limits.imageJpegQualities) {
    try {
      signal?.throwIfAborted()
      const jpegBytes = await resized().jpeg({ quality }).bytes()
      signal?.throwIfAborted()
      result.push(
        await candidateFromEncodedBytes({
          bytes: jpegBytes,
          mediaType: "image/jpeg",
          originalMediaType,
          fallbackWidth: Math.min(metadata.width, limits.imageMaxWidth),
          fallbackHeight: Math.min(metadata.height, limits.imageMaxHeight),
          limits,
        })
      )
    } catch {
      signal?.throwIfAborted()
      // Try the next quality; some source formats/platforms may reject a candidate.
    }
  }

  return result
}

async function candidateFromEncodedBytes(input: {
  readonly bytes: Uint8Array
  readonly mediaType: "image/png" | "image/jpeg"
  readonly originalMediaType: string
  readonly fallbackWidth: number
  readonly fallbackHeight: number
  readonly limits: AgentAttachmentLimits
}): Promise<ImageCandidate> {
  const metadata = await readImageMetadata(input.bytes, input.limits).catch(() => ({
    width: input.fallbackWidth,
    height: input.fallbackHeight,
    format: input.mediaType.split("/")[1] ?? "",
  }))
  return {
    base64: Buffer.from(input.bytes).toString("base64"),
    mediaType: input.mediaType,
    encodedSize: base64EncodedSize(input.bytes.byteLength),
    width: metadata.width,
    height: metadata.height,
    ...(input.originalMediaType === input.mediaType
      ? {}
      : { convertedFrom: input.originalMediaType }),
  }
}

function processedImageFromCandidate(
  candidate: ImageCandidate,
  original: ImageMetadata
): Extract<ProcessedAgentImage, { readonly ok: true }> {
  const notes = imageNotes({
    from: candidate.convertedFrom,
    to: candidate.mediaType,
    originalWidth: original.width,
    originalHeight: original.height,
    width: candidate.width,
    height: candidate.height,
  })

  return {
    ok: true,
    dataUrl: new URL(`data:${candidate.mediaType};base64,${candidate.base64}`),
    mediaType: candidate.mediaType,
    width: candidate.width,
    height: candidate.height,
    originalWidth: original.width,
    originalHeight: original.height,
    wasResized: candidate.width !== original.width || candidate.height !== original.height,
    notes,
  }
}

function base64EncodedSize(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

function mediaTypeForFormat(format: string): ImageCandidate["mediaType"] | "image/bmp" | undefined {
  const normalized = format.trim().toLowerCase()
  if (normalized === "bmp") {
    return "image/bmp"
  }
  return BUN_FORMAT_TO_MEDIA_TYPE[normalized]
}

function normalizedMediaType(value: string | undefined): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase()
  return normalized || undefined
}

function isSupportedInlineImageMediaType(
  mediaType: string
): mediaType is ImageCandidate["mediaType"] {
  return (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/webp" ||
    mediaType === "image/gif"
  )
}

function imageNotes(input: {
  readonly from: string | undefined
  readonly to: string
  readonly originalWidth: number
  readonly originalHeight: number
  readonly width: number
  readonly height: number
}): string[] {
  const notes: string[] = []
  if (input.from && input.from !== input.to) {
    notes.push(`[Image converted from ${input.from} to ${input.to}.]`)
  }
  if (input.width !== input.originalWidth || input.height !== input.originalHeight) {
    notes.push(
      `[Image resized from ${input.originalWidth}x${input.originalHeight} to ${input.width}x${input.height}.]`
    )
  }
  return notes
}

function imageErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
