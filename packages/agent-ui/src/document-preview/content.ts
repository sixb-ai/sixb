import { getAgentMessageFileContent } from "@sixb/client"
import { useQuery } from "@tanstack/react-query"
import { documentLoadError, textPreviewTooLarge } from "./content-policy"
import type { AgentDocumentSource } from "./types"

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
