import type { AgentDocumentKind } from "./types"

export type AgentDocumentPreviewRenderer =
  | "markdown"
  | "html-static"
  | "delimited-text"
  | "pdf-native"

/** Keep attachment click behavior and viewer dispatch on one supported-format decision. */
export function agentDocumentPreviewRenderer(
  kind: AgentDocumentKind | null
): AgentDocumentPreviewRenderer | null {
  if (kind === "markdown") return "markdown"
  if (kind === "html") return "html-static"
  if (kind === "csv" || kind === "tsv") return "delimited-text"
  if (kind === "pdf") return "pdf-native"
  return null
}
