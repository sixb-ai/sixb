import { createContext, useContext } from "react"
import type { ThreadDelegation } from "./interpret"

/** What a conversation lets its reader do with its sub-agents. */
export interface TranscriptDelegation {
  /**
   * Whether the reader may stop a sub-agent at work under this turn: whoever asked for the turn,
   * or the thread's owner.
   */
  readonly canStop: (runId: string) => boolean
}

/** What the sub-agent cards of a transcript read. */
export interface DelegationCardsContext {
  readonly threadId: string | null
  readonly delegation: ThreadDelegation
  /** The turn streaming now, which spawns the children whose runs are not listed yet. */
  readonly liveRunId: string | null
  /** Absent for a reader who only reads, such as an observer. */
  readonly actions?: TranscriptDelegation
}

/** Null outside a transcript, such as in a workflow's agent trace: no card is shown there. */
export const DelegationCardsContext = createContext<DelegationCardsContext | null>(null)

export function useDelegationCards(): DelegationCardsContext | null {
  return useContext(DelegationCardsContext)
}
