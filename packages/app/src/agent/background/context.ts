import { createContext, useContext } from "react"
import type { BackgroundSource, ThreadBackground } from "./interpret"

/** What a conversation knows of its background commands, and lets its reader do with them. */
export interface TranscriptBackground {
  readonly source: BackgroundSource
  /**
   * Ask its computer to stop a command, which it does at once: its owner's, while their `sixb`
   * runs it. Absent for anyone else.
   */
  readonly stop?: (command: { readonly id: string; readonly startedAt: string }) => Promise<void>
}

/** What the background command cards of a transcript read. */
export interface BackgroundCardsContext extends TranscriptBackground {
  readonly thread: ThreadBackground
  /** The turn streaming now, which runs the commands it started. */
  readonly liveRunId: string | null
}

/** Null outside a transcript, such as in a workflow's agent trace: no card is shown there. */
export const BackgroundCardsContext = createContext<BackgroundCardsContext | null>(null)

export function useBackgroundCards(): BackgroundCardsContext | null {
  return useContext(BackgroundCardsContext)
}
