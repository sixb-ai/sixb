export interface FileRefValue {
  readonly blobId: string
  readonly digest: string
  readonly sizeBytes: number
  readonly fileName?: string
  readonly mediaType?: string
  readonly logicalPath?: string
}

export interface FileValueContext {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly pathSegments: readonly string[]
}

export function isFileRefValue(value: unknown): value is FileRefValue {
  return (
    isRecord(value) &&
    typeof value.blobId === "string" &&
    typeof value.digest === "string" &&
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes) &&
    (value.fileName === undefined || typeof value.fileName === "string") &&
    (value.mediaType === undefined || typeof value.mediaType === "string") &&
    (value.logicalPath === undefined || typeof value.logicalPath === "string")
  )
}

export function isFileRefDisplayValue(value: unknown): boolean {
  return (
    isFileRefValue(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isFileRefValue))
  )
}

export function fileRefName(fileRef: FileRefValue): string {
  const fileName = pathTail(fileRef.fileName)
  if (fileName) return fileName

  const logicalPathName = pathTail(fileRef.logicalPath)
  if (logicalPathName) return logicalPathName

  return `${fileRef.blobId}.bin`
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

function pathTail(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? null
}

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
