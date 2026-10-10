/**
 * Keep preview policy separate from React Query. Bun's test loader shares resolver state with
 * Atlas's in-process HTML bundler, so unit tests importing the hook module can corrupt bundling.
 */
import { isSixbApiError } from "@sixb/client"
import type { AgentDocumentSource } from "./types"

export const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024
export const MAX_MARKDOWN_PREVIEW_BYTES = MAX_TEXT_PREVIEW_BYTES

export function textPreviewTooLarge(source: AgentDocumentSource): boolean {
  return source.fileRef.sizeBytes > MAX_TEXT_PREVIEW_BYTES
}

export function markdownPreviewTooLarge(source: AgentDocumentSource): boolean {
  return textPreviewTooLarge(source)
}

export function customPreviewTooLarge(
  source: AgentDocumentSource,
  maxFileSizeBytes: number
): boolean {
  if (!Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes <= 0) return true
  if (!Number.isFinite(source.fileRef.sizeBytes) || source.fileRef.sizeBytes < 0) return true
  return source.fileRef.sizeBytes > maxFileSizeBytes
}

/** Why a document could not load, as a message key of the viewer's catalog. */
export type DocumentLoadError = "gone" | "storageUnavailable" | "loadFailed"

export function documentLoadError(error: unknown): DocumentLoadError {
  if (isSixbApiError(error)) {
    if (error.status === 404) return "gone"
    if (error.status === 501) return "storageUnavailable"
  }
  return "loadFailed"
}
