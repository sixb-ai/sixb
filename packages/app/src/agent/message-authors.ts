import { createContext, useContext, useMemo } from "react"
import type { CurrentUser } from "../session"
import { isShared, threadOwner, threadParticipants, userPrincipal } from "./sharing"
import type { AgentMessage, AgentThread } from "./types"

/** A message page's `authors`: who wrote its messages, with an account's display name. */
export interface MessageAuthor {
  readonly type: string
  readonly id: string
  readonly displayName?: string
}

/** How a message names its author: what the line says, and whose initials the avatar shows. */
export interface AuthorLabel {
  /** "You" for the reader, else the author's name. */
  readonly label: string
  /** The author's name, or their id when their account has none. */
  readonly name: string
}

/**
 * Set around a conversation whose messages name their author: someone else's, read by an observer,
 * or one shared between several people.
 */
export interface MessageAuthors {
  readonly authorOf: (message: AgentMessage) => AuthorLabel | undefined
  /** The reader, who labels a message they just sent before it is saved. */
  readonly reader?: AuthorLabel & { readonly key: string }
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

/** Someone's name when the thread's people or the page's authors give one. */
export function knownName(
  principal: { readonly type: string; readonly id: string },
  thread: AgentThread | null,
  authors: readonly MessageAuthor[] | undefined
): string | undefined {
  const key = principalKey(principal)
  const people = thread ? [threadOwner(thread), ...threadParticipants(thread)] : []
  const person = people.find((entry) => principalKey(entry.principal) === key)
  if (person?.displayName) return person.displayName

  return authors?.find((entry) => principalKey(entry) === key)?.displayName
}

/** Who wrote a message, by `type:id`, to tell when the next one comes from someone else. */
export function authorKey(message: AgentMessage): string | null {
  return message.authorPrincipal ? principalKey(message.authorPrincipal) : null
}

/** Names each message's author from a map of names; the reader's own say `you`. */
export function messageAuthors(
  names: ReadonlyMap<string, string>,
  reader?: { readonly key: string; readonly label: string }
): MessageAuthors {
  const labelOf = (key: string): AuthorLabel | undefined => {
    const name = names.get(key)
    if (name === undefined) return undefined

    return { label: key === reader?.key ? reader.label : name, name }
  }

  const self = reader ? labelOf(reader.key) : undefined

  return {
    authorOf: (message) => {
      const key = authorKey(message)
      return key ? labelOf(key) : undefined
    },
    ...(reader && self ? { reader: { ...self, key: reader.key } } : {}),
  }
}

/**
 * How the reader's own conversation names its authors: only once more than one person takes part,
 * or more than one wrote in it, as in a copy of a shared conversation. The reader's own read `you`.
 */
export function useConversationAuthors({
  thread,
  authors,
  user,
  you,
}: {
  readonly thread: AgentThread | null
  readonly authors: readonly MessageAuthor[] | undefined
  readonly user: CurrentUser | null
  readonly you: string
}): MessageAuthors | null {
  return useMemo(() => {
    if (!isShared(thread) && (authors?.length ?? 0) < 2) return null

    const names = new Map(authorNames(authors))
    const people = thread ? [threadOwner(thread), ...threadParticipants(thread)] : []
    for (const person of people) {
      if (person.displayName) names.set(principalKey(person.principal), person.displayName)
    }

    const me = userPrincipal(user)
    if (!me) return messageAuthors(names)

    const key = principalKey(me)
    if (!names.has(key)) names.set(key, user?.displayName ?? user?.email ?? me.id)

    return messageAuthors(names, { key, label: you })
  }, [thread, authors, user, you])
}
