// How the viewer shows a file, decided from its metadata alone, before reading any bytes.
import { isSixbApiError } from "@sixb/client"
import type { ViewerFileRef } from "./file-source"

export type FileView = "image" | "pdf" | "markdown" | "csv" | "tsv" | "text" | "download"

/** Text files are read whole; larger ones offer the download instead. */
export const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024

const GENERIC_MEDIA_TYPES = new Set(["application/octet-stream", "binary/octet-stream"])
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"])
const TEXT_TYPES = new Set([
  "text/plain",
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "text/css",
  "text/xml",
])

export function fileView(fileRef: Pick<ViewerFileRef, "mediaType" | "fileName">): FileView {
  const mediaType = fileRef.mediaType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType && !GENERIC_MEDIA_TYPES.has(mediaType)) return viewFromMediaType(mediaType)
  return viewFromFileName(fileRef.fileName?.trim().toLowerCase() ?? "")
}

/** Why a file could not load, as a key of the viewer's `files` messages. */
export type FileLoadError = "gone" | "storageUnavailable" | "loadFailed"

export function fileLoadError(error: unknown): FileLoadError {
  if (isSixbApiError(error)) {
    if (error.status === 404) return "gone"
    if (error.status === 501) return "storageUnavailable"
  }
  return "loadFailed"
}

function viewFromMediaType(mediaType: string): FileView {
  if (IMAGE_TYPES.has(mediaType)) return "image"
  if (mediaType === "application/pdf") return "pdf"
  if (mediaType === "text/markdown") return "markdown"
  if (mediaType === "text/csv") return "csv"
  if (mediaType === "text/tab-separated-values") return "tsv"
  if (TEXT_TYPES.has(mediaType)) return "text"
  return "download"
}

function viewFromFileName(name: string): FileView {
  if (/\.(png|jpe?g|webp|gif|svg)$/.test(name)) return "image"
  if (name.endsWith(".pdf")) return "pdf"
  if (/\.(md|markdown)$/.test(name)) return "markdown"
  if (name.endsWith(".csv")) return "csv"
  if (name.endsWith(".tsv")) return "tsv"
  if (/\.(txt|json|jsonl|xml|ya?ml|css|log)$/.test(name)) return "text"
  return "download"
}
