import { createContext, useContext } from "react"
import type { AgentMessage } from "./types"

/**
 * Set around a conversation read with `can.observe(agent.threads)`: someone else's, so its messages
 * name their author and its files are read through the observer's routes.
 */
export interface ObservedThread {
  /** The author's name, or their id when their account has none. */
  readonly authorOf: (message: AgentMessage) => string | undefined
}

export const ObservedThreadContext = createContext<ObservedThread | null>(null)

/** The observed conversation around a message, or null in the reader's own conversations. */
export function useObservedThread(): ObservedThread | null {
  return useContext(ObservedThreadContext)
}
