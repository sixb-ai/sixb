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

export function documentLoadError(error: unknown): string {
  if (isSixbApiError(error)) {
    if (error.status === 404) return "This document is no longer available."
    if (error.status === 501) return "Document storage is not available."
  }
  return "Could not load this document."
}
