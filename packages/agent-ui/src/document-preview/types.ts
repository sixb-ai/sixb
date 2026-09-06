import type { ComponentType } from "react"
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

export interface AgentDocumentPreviewRendererProps {
  /** Serializable metadata for the durable message file. */
  readonly file: AgentFileRef
  /** Content loaded through the configured Sixb client after the size policy succeeds. */
  readonly source: Blob
}

/** Optional document viewer supplied by the host application. Registered viewers keep priority. */
export interface AgentDocumentPreviewRenderer {
  /** Stable diagnostic identity. */
  readonly id: string
  /** Maximum declared file size accepted before any content is downloaded. */
  readonly maxFileSizeBytes: number
  /** Metadata-only capability check. It must not fetch or parse the document. */
  readonly supports: (file: AgentFileRef) => boolean
  /** May be a React.lazy component; the preview surface provides its Suspense boundary. */
  readonly component: ComponentType<AgentDocumentPreviewRendererProps>
}
