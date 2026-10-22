import { createContext, useContext } from "react"
import type { AgentMessage } from "./types"

/** A message page's `authors`: who wrote its messages, with an account's display name. */
export interface MessageAuthor {
  readonly type: string
  readonly id: string
  readonly displayName?: string
}

/**
 * Set around a conversation whose messages name their author: someone else's, read by an observer,
 * or one shared between several people.
 */
export interface MessageAuthors {
  /** The author's name, or their id when their account has none. */
  readonly authorOf: (message: AgentMessage) => string | undefined
  /** The label of a message the reader just sent, before it is saved. */
  readonly pending?: string
}

export const MessageAuthorsContext = createContext<MessageAuthors | null>(null)

/** How messages name their author here, or null where they do not. */
export function useMessageAuthors(): MessageAuthors | null {
  return useContext(MessageAuthorsContext)
}

/** Authors by `type:id`, with their name or else their id. */
export function authorNames(
  authors: readonly MessageAuthor[] | undefined
): ReadonlyMap<string, string> {
  return new Map(
    (authors ?? []).map((author) => [principalKey(author), author.displayName ?? author.id])
  )
}

export function principalKey(principal: { readonly type: string; readonly id: string }): string {
  return `${principal.type}:${principal.id}`
}

/** Names each message's author from a map of names. */
export function messageAuthors(
  names: ReadonlyMap<string, string>,
  pending?: string
): MessageAuthors {
  return {
    authorOf: (message) => {
      const principal = message.authorPrincipal
      return principal ? names.get(principalKey(principal)) : undefined
    },
    ...(pending === undefined ? {} : { pending }),
  }
}
