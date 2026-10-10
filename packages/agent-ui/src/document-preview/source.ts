import { client } from "@sixb/client"
import type { AgentFileRef } from "../types"
import { agentDocumentKind } from "./classify"
import type { AgentDocumentSource } from "./types"

export interface CreateAgentDocumentSourceInput {
  readonly threadId: string
  readonly messageId: string
  /** JSON pointer to the file reference in the message, such as `/parts/2/fileRef`. */
  readonly path: string
  readonly fileRef: AgentFileRef
  /** Explicit base URL for pure callers and tests. Defaults to the configured Sixb client URL. */
  readonly baseUrl?: string
}

export function createAgentDocumentSource(
  input: CreateAgentDocumentSourceInput
): AgentDocumentSource {
  return {
    id: input.fileRef.blobId,
    kind: agentDocumentKind(input.fileRef.mediaType, input.fileRef.fileName),
    fileRef: input.fileRef,
    threadId: input.threadId,
    messageId: input.messageId,
    path: input.path,
    inlineUrl: agentMessageFileContentUrl(input, "inline"),
    downloadUrl: agentMessageFileContentUrl(input, "attachment"),
  }
}

function agentMessageFileContentUrl(
  input: CreateAgentDocumentSourceInput,
  disposition: "inline" | "attachment"
): string {
  const routePath = `/api/agent-threads/${encodeURIComponent(input.threadId)}/messages/${encodeURIComponent(
    input.messageId
  )}/files/content`
  const params = new URLSearchParams({ path: input.path, disposition })
  const baseUrl = input.baseUrl ?? client.getConfig().baseUrl

  if (!baseUrl && typeof window === "undefined") {
    return `${routePath}?${params}`
  }

  const url = new URL(routePath, baseUrl ?? window.location.origin)
  url.search = params.toString()
  return url.toString()
}
