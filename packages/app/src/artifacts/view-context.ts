import { createContext, useContext } from "react"

/** What the reader may do with the artifact the viewer shows, and where it is. */
export interface ArtifactViewContext {
  /** As the API says it: everything as its owner, publish as a participant, or only read. */
  readonly access: "owner" | "update" | "read"
  /** The artifact's latest version, and its revision now. */
  readonly latestVersion: number
  readonly revision: number
}

const Context = createContext<ArtifactViewContext | null>(null)

export const ArtifactViewProvider = Context.Provider

/** The artifact the viewer shows, for a renderer that acts on it; null outside the viewer. */
export function useArtifactView(): ArtifactViewContext | null {
  return useContext(Context)
}

/**
 * Where the viewer puts a message for the Agent: in the input of the conversation it opens
 * beside, never sent on its own. Null where there is no conversation to write in.
 */
export const AgentDraftContext = createContext<((text: string) => void) | null>(null)

export function useAgentDraft(): ((text: string) => void) | null {
  return useContext(AgentDraftContext)
}

/** Where words for the Agent wait for the next conversation that opens, as a page goes home. */
const PENDING_DRAFT_KEY = "sixb.agent.pending-draft"

/** Keeps words for the next conversation that opens in this tab. */
export function keepAgentDraft(text: string): void {
  try {
    globalThis.sessionStorage?.setItem(PENDING_DRAFT_KEY, text)
  } catch {
    // A tab that keeps nothing opens the conversation without them.
  }
}

/** The words kept for the next conversation, taken once. */
export function takeAgentDraft(): string | null {
  try {
    const text = globalThis.sessionStorage?.getItem(PENDING_DRAFT_KEY) ?? null
    if (text !== null) globalThis.sessionStorage?.removeItem(PENDING_DRAFT_KEY)
    return text
  } catch {
    return null
  }
}
