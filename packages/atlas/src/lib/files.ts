import { type FileRef, isFileRef } from "@sixb/core/blob-storage"

export interface FileValueContext {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly pathSegments: readonly string[]
}

/**
 * How an object property value should render as file attachments. This is the
 * single source of truth shared by the detail layout (does this row need
 * attachment spacing?) and the value renderer (one attachment vs. a list), so
 * the two can never disagree about what counts as a file. It also carries the
 * narrowed `FileRef`(s) so callers render without re-checking or casting.
 */
export type FileValueClassification =
  | { readonly kind: "single"; readonly fileRef: FileRef }
  | { readonly kind: "array"; readonly fileRefs: readonly FileRef[] }
  | { readonly kind: "none" }

export function classifyFileValue(value: unknown): FileValueClassification {
  if (isFileRef(value)) {
    return { kind: "single", fileRef: value }
  }
  // Bind to `unknown[]` (not the `any[]` that `Array.isArray` yields) so
  // `every(isFileRef)` genuinely narrows `items` to `FileRef[]`. This makes the
  // runtime guard load-bearing at the type level too: dropping it would fail to
  // compile rather than silently letting non-FileRef elements through.
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    if (items.length > 0 && items.every(isFileRef)) {
      return { kind: "array", fileRefs: items }
    }
  }
  return { kind: "none" }
}

export function fileMediaLabel(mediaType: string | undefined, fileName: string): string {
  const normalized = mediaType?.trim().toLowerCase()
  if (normalized === "application/pdf") return "PDF"
  if (normalized === "text/markdown" || fileName.toLowerCase().endsWith(".md")) return "Markdown"
  if (normalized === "text/plain") return "Text"
  if (normalized?.startsWith("image/")) {
    const subtype = normalized.slice("image/".length).toUpperCase()
    return `${subtype === "JPG" ? "JPEG" : subtype} image`
  }
  if (normalized?.startsWith("text/")) return "Text"
  if (normalized) return normalized
  return "File"
}

export function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "Unknown size"

  const units = ["B", "KB", "MB", "GB", "TB"] as const
  let value = sizeBytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const maximumFractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${units[unitIndex]}`
}

export function objectFileContentUrl(input: {
  readonly baseUrl: string
  readonly context: FileValueContext
  readonly disposition?: "attachment" | "inline"
}): string {
  const url = new URL(
    `/api/objects/${encodeURIComponent(input.context.objectTypeId)}/${encodeURIComponent(
      input.context.primaryId
    )}/files/content`,
    input.baseUrl
  )
  url.searchParams.set(
    "path",
    `/properties/${input.context.pathSegments.map(jsonPointerSegment).join("/")}`
  )
  if (input.disposition) {
    url.searchParams.set("disposition", input.disposition)
  }
  return url.toString()
}

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1")
}
