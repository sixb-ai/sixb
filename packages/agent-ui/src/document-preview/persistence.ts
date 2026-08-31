import { type DocumentPreviewState, EMPTY_DOCUMENT_PREVIEW_STATE } from "./state"
import type { AgentDocumentKind, AgentDocumentSource } from "./types"

const STORAGE_KEY_PREFIX = "sixb.agent-ui.document-preview.v1:"
const DOCUMENT_KINDS = new Set<AgentDocumentKind>(["markdown", "html", "csv", "tsv", "pdf"])

export function documentPreviewStorageKey(threadId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(threadId)}`
}

export function readDocumentPreviewState(threadId: string): DocumentPreviewState {
  if (typeof window === "undefined") return EMPTY_DOCUMENT_PREVIEW_STATE

  try {
    return parseDocumentPreviewState(
      window.localStorage.getItem(documentPreviewStorageKey(threadId)),
      threadId
    )
  } catch {
    return EMPTY_DOCUMENT_PREVIEW_STATE
  }
}

export function writeDocumentPreviewState(threadId: string, state: DocumentPreviewState): void {
  if (typeof window === "undefined") return

  try {
    const key = documentPreviewStorageKey(threadId)
    if (state.documents.length === 0 && state.panelWidth === null) {
      window.localStorage.removeItem(key)
      return
    }

    const serialized = JSON.stringify(state)
    if (window.localStorage.getItem(key) !== serialized) {
      window.localStorage.setItem(key, serialized)
    }
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function parseDocumentPreviewState(
  serialized: string | null,
  threadId: string
): DocumentPreviewState {
  if (!serialized) return EMPTY_DOCUMENT_PREVIEW_STATE

  try {
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value) || !Array.isArray(value.documents)) {
      return EMPTY_DOCUMENT_PREVIEW_STATE
    }

    const seen = new Set<string>()
    const documents = value.documents.filter((document): document is AgentDocumentSource => {
      if (!isDocumentSource(document) || document.threadId !== threadId || seen.has(document.id)) {
        return false
      }
      seen.add(document.id)
      return true
    })
    const panelWidth = validPanelWidth(value.panelWidth) ? value.panelWidth : null
    if (documents.length === 0) {
      return panelWidth === null
        ? EMPTY_DOCUMENT_PREVIEW_STATE
        : { documents: [], activeId: null, panelWidth }
    }

    const activeId =
      typeof value.activeId === "string" &&
      documents.some((document) => document.id === value.activeId)
        ? value.activeId
        : (documents.at(-1)?.id ?? null)

    return { documents, activeId, panelWidth }
  } catch {
    return EMPTY_DOCUMENT_PREVIEW_STATE
  }
}

function isDocumentSource(value: unknown): value is AgentDocumentSource {
  if (!isRecord(value) || !isRecord(value.fileRef)) return false

  const { fileRef } = value
  return (
    typeof value.id === "string" &&
    (value.kind === null ||
      (typeof value.kind === "string" && DOCUMENT_KINDS.has(value.kind as AgentDocumentKind))) &&
    typeof value.threadId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.partIndex === "number" &&
    Number.isInteger(value.partIndex) &&
    typeof value.inlineUrl === "string" &&
    typeof value.downloadUrl === "string" &&
    typeof fileRef.blobId === "string" &&
    typeof fileRef.digest === "string" &&
    typeof fileRef.sizeBytes === "number" &&
    optionalString(fileRef.fileName) &&
    optionalString(fileRef.mediaType) &&
    optionalString(fileRef.logicalPath)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function validPanelWidth(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10_000
}
