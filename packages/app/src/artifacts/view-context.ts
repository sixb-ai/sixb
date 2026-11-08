import type { AgentContextInput } from "@sixb/core/agents/context"
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
 * What the viewer hands the conversation for the Agent: a sentence the person may change, and
 * context that goes with their message, shown as a chip, such as the comments they chose.
 */
export interface AgentDraft {
  readonly text: string
  readonly context?: AgentContextInput
}

/**
 * Where the viewer puts a message for the Agent: in the input of the conversation it opens
 * beside, never sent on its own. Null where there is no conversation to write in.
 */
export const AgentDraftContext = createContext<((draft: AgentDraft) => void) | null>(null)

export function useAgentDraft(): ((draft: AgentDraft) => void) | null {
  return useContext(AgentDraftContext)
}

/** Where words for the Agent wait for the next conversation that opens, as a page goes home. */
const PENDING_DRAFT_KEY = "sixb.agent.pending-draft"

/** How long words kept for the Agent wait: the next page opens at once, or never takes them. */
export const PENDING_DRAFT_MS = 2 * 60_000

/** Whose words they are: the next conversation takes them only for the same person and project. */
export interface AgentDraftOwner {
  readonly userId: string | null
  readonly projectId: string
}

interface PendingAgentDraft extends AgentDraftOwner, AgentDraft {
  readonly artifactId: string
  readonly at: number
}

/** Keeps words about an artifact for the next conversation that opens in this tab. */
export function keepAgentDraft(
  draft: AgentDraftOwner & AgentDraft & { readonly artifactId: string },
  now = Date.now()
): void {
  try {
    globalThis.sessionStorage?.setItem(PENDING_DRAFT_KEY, JSON.stringify({ ...draft, at: now }))
  } catch {
    // A tab that keeps nothing opens the conversation without them.
  }
}

/**
 * The words kept for the next conversation, taken once: only by the same person in the same
 * project, and only for {@link PENDING_DRAFT_MS}. Anything else is dropped.
 */
export function takeAgentDraft(owner: AgentDraftOwner, now = Date.now()): AgentDraft | null {
  let kept: unknown
  try {
    const text = globalThis.sessionStorage?.getItem(PENDING_DRAFT_KEY) ?? null
    if (text === null) return null
    globalThis.sessionStorage?.removeItem(PENDING_DRAFT_KEY)
    kept = JSON.parse(text)
  } catch {
    return null
  }

  if (!isPendingDraft(kept)) return null
  const fresh = now - kept.at >= 0 && now - kept.at <= PENDING_DRAFT_MS
  if (!fresh || kept.userId !== owner.userId || kept.projectId !== owner.projectId) return null
  return { text: kept.text, ...(kept.context ? { context: kept.context } : {}) }
}

function isPendingDraft(value: unknown): value is PendingAgentDraft {
  if (typeof value !== "object" || value === null) return false
  const draft = value as Record<string, unknown>
  return (
    (draft.userId === null || typeof draft.userId === "string") &&
    typeof draft.projectId === "string" &&
    typeof draft.artifactId === "string" &&
    typeof draft.text === "string" &&
    typeof draft.at === "number" &&
    (draft.context === undefined || (typeof draft.context === "object" && draft.context !== null))
  )
}
