import type { AgentDocumentSource } from "./types"

export interface DocumentPreviewState {
  readonly documents: readonly AgentDocumentSource[]
  readonly activeId: string | null
}

export type DocumentPreviewAction =
  | { readonly type: "open"; readonly document: AgentDocumentSource }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "close"; readonly id: string }
  | { readonly type: "close-all" }

export type DocumentTabNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End"

export const EMPTY_DOCUMENT_PREVIEW_STATE: DocumentPreviewState = {
  documents: [],
  activeId: null,
}

export function documentPreviewReducer(
  state: DocumentPreviewState,
  action: DocumentPreviewAction
): DocumentPreviewState {
  switch (action.type) {
    case "open": {
      const existing = state.documents.some((document) => document.id === action.document.id)
      return {
        documents: existing ? state.documents : [...state.documents, action.document],
        activeId: action.document.id,
      }
    }
    case "select":
      return state.documents.some((document) => document.id === action.id)
        ? { ...state, activeId: action.id }
        : state
    case "close":
      return closeDocument(state, action.id)
    case "close-all":
      return EMPTY_DOCUMENT_PREVIEW_STATE
    default:
      action satisfies never
      return state
  }
}

export function documentTabIdAfterKey(
  ids: readonly string[],
  currentId: string,
  key: DocumentTabNavigationKey
): string | null {
  if (ids.length === 0) return null
  if (key === "Home") return ids[0] ?? null
  if (key === "End") return ids.at(-1) ?? null

  const currentIndex = ids.indexOf(currentId)
  if (currentIndex === -1) return ids[0] ?? null
  const offset = key === "ArrowRight" ? 1 : -1
  return ids[(currentIndex + offset + ids.length) % ids.length] ?? null
}

function closeDocument(state: DocumentPreviewState, id: string): DocumentPreviewState {
  const closedIndex = state.documents.findIndex((document) => document.id === id)
  if (closedIndex === -1) return state

  const documents = state.documents.filter((document) => document.id !== id)
  if (state.activeId !== id) return { documents, activeId: state.activeId }

  const nextActive = documents[closedIndex] ?? documents[closedIndex - 1]
  return { documents, activeId: nextActive?.id ?? null }
}
