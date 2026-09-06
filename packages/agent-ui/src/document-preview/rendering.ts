import type {
  AgentDocumentKind,
  AgentDocumentSource,
  AgentDocumentPreviewRenderer as CustomDocumentPreviewRenderer,
} from "./types"

export type BuiltInDocumentPreviewRenderer =
  | "markdown"
  | "html-static"
  | "delimited-text"
  | "pdf-native"
  | "image-native"

export type ResolvedAgentDocumentPreview =
  | { readonly type: "built-in"; readonly renderer: BuiltInDocumentPreviewRenderer }
  | { readonly type: "custom"; readonly renderer: CustomDocumentPreviewRenderer }

/** Keep attachment click behavior and viewer dispatch on one supported-format decision. */
export function agentDocumentPreviewRenderer(
  kind: AgentDocumentKind | null
): BuiltInDocumentPreviewRenderer | null {
  if (kind === "markdown") return "markdown"
  if (kind === "html") return "html-static"
  if (kind === "csv" || kind === "tsv") return "delimited-text"
  if (kind === "pdf") return "pdf-native"
  if (kind === "image") return "image-native"
  return null
}

/** The host may override any format; built-ins remain the fallback. */
export function resolveAgentDocumentPreview(
  document: AgentDocumentSource,
  customRenderers: readonly CustomDocumentPreviewRenderer[]
): ResolvedAgentDocumentPreview | null {
  for (const renderer of customRenderers) {
    try {
      if (renderer.supports(document.fileRef)) return { type: "custom", renderer }
    } catch (error) {
      console.error(
        `[SixbAgentUI] Document preview renderer '${renderer.id}' failed its capability check.`,
        error
      )
    }
  }

  const builtIn = agentDocumentPreviewRenderer(document.kind)
  return builtIn ? { type: "built-in", renderer: builtIn } : null
}
