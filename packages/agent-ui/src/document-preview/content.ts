import { getAgentMessageFileContent, isSixbApiError } from "@sixb/client"
import { useQuery } from "@tanstack/react-query"
import type { AgentDocumentSource } from "./types"

export const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024
export const MAX_MARKDOWN_PREVIEW_BYTES = MAX_TEXT_PREVIEW_BYTES

export function textPreviewTooLarge(source: AgentDocumentSource): boolean {
  return source.fileRef.sizeBytes > MAX_TEXT_PREVIEW_BYTES
}

export function markdownPreviewTooLarge(source: AgentDocumentSource): boolean {
  return textPreviewTooLarge(source)
}

export function useMarkdownDocument(source: AgentDocumentSource) {
  return useTextDocument(source)
}

export function useHtmlDocument(source: AgentDocumentSource) {
  return useTextDocument(source)
}

export function useDelimitedTextDocument(source: AgentDocumentSource) {
  return useTextDocument(source)
}

function useTextDocument(source: AgentDocumentSource) {
  const tooLarge = textPreviewTooLarge(source)
  const query = useQuery({
    queryKey: [
      "agent-document-preview",
      source.threadId,
      source.messageId,
      source.partIndex,
      source.fileRef.digest,
    ],
    enabled: !tooLarge,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) => {
      const response = await getAgentMessageFileContent({
        path: { threadId: source.threadId, messageId: source.messageId },
        query: { path: `/parts/${source.partIndex}/fileRef`, disposition: "inline" },
        parseAs: "blob",
        throwOnError: true,
        signal,
      })
      return response.data.text()
    },
  })

  return {
    text: query.data,
    loading: query.isLoading,
    error: query.error ? documentLoadError(query.error) : null,
    tooLarge,
  }
}

export function documentLoadError(error: unknown): string {
  if (isSixbApiError(error)) {
    if (error.status === 404) return "This document is no longer available."
    if (error.status === 501) return "Document storage is not available."
  }
  return "Could not load this document."
}
