import { useCallback, useState } from "react"

/** Words waiting to join the composer's input, numbered so the same words handed twice join twice. */
export interface ComposerInsertion {
  readonly text: string
  readonly nonce: number
}

/**
 * Words an artifact hands the conversation's input, held until the composer took them: once it
 * has, they are gone, so a composer drawn again, as when the conversation's first message replaces
 * its welcome, does not add them a second time.
 */
export function useComposerInsertion(): {
  readonly insertion: ComposerInsertion | undefined
  readonly insert: (text: string) => void
  readonly inserted: (nonce: number) => void
} {
  const [pending, setPending] = useState<ComposerInsertion | undefined>(undefined)

  const insert = useCallback(
    (text: string) => setPending((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 })),
    []
  )
  const inserted = useCallback(
    (nonce: number) => setPending((current) => (current?.nonce === nonce ? undefined : current)),
    []
  )
  return { insertion: pending, insert, inserted }
}
