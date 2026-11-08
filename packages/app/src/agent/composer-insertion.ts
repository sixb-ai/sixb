import type { AgentContextInput } from "@sixb/core/agents/context"
import { useCallback, useState } from "react"

/**
 * Words waiting to join the composer's input, and context to join its chips, numbered so the same
 * handed twice joins twice.
 */
export interface ComposerInsertion {
  readonly text: string
  readonly context?: AgentContextInput
  readonly nonce: number
}

/**
 * Words an artifact hands the conversation's input, held until the composer took them: once it
 * has, they are gone, so a composer drawn again, as when the conversation's first message replaces
 * its welcome, does not add them a second time.
 */
export function useComposerInsertion(): {
  readonly insertion: ComposerInsertion | undefined
  readonly insert: (draft: { readonly text: string; readonly context?: AgentContextInput }) => void
  readonly inserted: (nonce: number) => void
} {
  const [pending, setPending] = useState<ComposerInsertion | undefined>(undefined)

  const insert = useCallback(
    (draft: { readonly text: string; readonly context?: AgentContextInput }) =>
      setPending((current) => ({ ...draft, nonce: (current?.nonce ?? 0) + 1 })),
    []
  )
  const inserted = useCallback(
    (nonce: number) => setPending((current) => (current?.nonce === nonce ? undefined : current)),
    []
  )
  return { insertion: pending, insert, inserted }
}
