import { createContext, useContext } from "react"

/**
 * Set around a conversation read with `can.observe(agent.threads)`: someone else's, so its files are
 * read through the observer's routes. Its authors are named through `MessageAuthorsContext`.
 */
export const ObservedThreadContext = createContext(false)

/** Whether the conversation around a message is observed rather than the reader's own. */
export function useObservedThread(): boolean {
  return useContext(ObservedThreadContext)
}
