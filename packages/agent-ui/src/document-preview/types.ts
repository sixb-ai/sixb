import type { AgentFileRef } from "../types"

export type AgentDocumentKind = "markdown" | "html" | "csv" | "tsv" | "pdf" | "image"

/** A file part tied to the durable message route that authorizes reading its bytes. */
export interface AgentDocumentSource {
  readonly id: string
  readonly kind: AgentDocumentKind | null
  readonly fileRef: AgentFileRef
  readonly threadId: string
  readonly messageId: string
  readonly partIndex: number
  readonly inlineUrl: string
  readonly downloadUrl: string
}
