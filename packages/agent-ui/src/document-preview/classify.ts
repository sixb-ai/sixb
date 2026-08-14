import type { AgentDocumentKind } from "./types"

const GENERIC_MEDIA_TYPES = new Set(["application/octet-stream", "binary/octet-stream"])

/** Classify only formats the in-app viewer intentionally supports. */
export function agentDocumentKind(
  mediaType: string | undefined,
  fileName: string | undefined
): AgentDocumentKind | null {
  const normalizedType = mediaType?.split(";", 1)[0]?.trim().toLowerCase()
  const fromType = normalizedType ? kindFromMediaType(normalizedType) : null
  if (fromType) return fromType

  if (normalizedType && !GENERIC_MEDIA_TYPES.has(normalizedType)) return null
  return kindFromFileName(fileName)
}

function kindFromMediaType(mediaType: string): AgentDocumentKind | null {
  switch (mediaType) {
    case "text/markdown":
      return "markdown"
    case "text/html":
    case "application/xhtml+xml":
      return "html"
    case "text/csv":
      return "csv"
    case "text/tab-separated-values":
      return "tsv"
    case "application/pdf":
      return "pdf"
    default:
      return null
  }
}

function kindFromFileName(fileName: string | undefined): AgentDocumentKind | null {
  const normalized = fileName?.trim().toLowerCase()
  if (!normalized) return null
  if (normalized.endsWith(".markdown") || normalized.endsWith(".md")) return "markdown"
  if (normalized.endsWith(".html") || normalized.endsWith(".htm")) return "html"
  if (normalized.endsWith(".csv")) return "csv"
  if (normalized.endsWith(".tsv")) return "tsv"
  if (normalized.endsWith(".pdf")) return "pdf"
  return null
}
