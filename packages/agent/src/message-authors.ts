import { type Principal, principalsEqual, type UserPrincipal } from "@sixb/core"
import type { AgentMessageRecord, AgentThreadRecord } from "@sixb/core/storage"
import {
  type ConversationPerson,
  renderConversationPeople,
  renderMessageAuthor,
} from "./agent-prompt"

/** What the model reads of who writes in a conversation. Nothing of it is stored or shown. */
export interface ConversationAuthors {
  /** Who takes part, for the system prompt; absent in a one-person conversation. */
  readonly section?: string
  /** The `<sixb_author>` closing each retained user message, by message id. */
  readonly byMessageId: ReadonlyMap<string, string>
}

const ALONE: ConversationAuthors = { byMessageId: new Map() }

/**
 * A thread with the participants who can read it now: the people the model is told about, with
 * their display names as the turn read them (`AgentTurnContext.readers` and `names`).
 */
export interface ConversationReaders {
  readonly thread: AgentThreadRecord
  readonly participants: readonly UserPrincipal[]
  readonly names: Readonly<Record<string, string>>
}

/**
 * Who wrote each retained user message, when the thread has participants or several people wrote
 * in it; nothing in a conversation its owner holds alone, so its messages do not change.
 *
 * Each message's author derives from stored data, so a turn replays the bytes the previous one
 * sent. They change only when someone renames their account. The section naming who takes part
 * goes in the system prompt, the same whoever sends the turn: it changes when someone joins or
 * leaves, or is renamed.
 */
export function conversationAuthors(input: {
  readonly conversation: ConversationReaders
  readonly messages: readonly AgentMessageRecord[]
}): ConversationAuthors {
  const { thread, participants, names } = input.conversation

  const authored = input.messages.filter(
    (message): message is AgentMessageRecord & { authorPrincipal: Principal } =>
      message.role === "user" && message.authorPrincipal !== undefined
  )
  const owner = thread.ownerPrincipal
  const someoneElseWrote = authored.some(
    (message) => !principalsEqual(message.authorPrincipal, owner)
  )
  if (participants.length === 0 && !someoneElseWrote) return ALONE

  // Each user goes by their display name; anyone else, or a user without one, by their id.
  const personOf = (principal: Principal): ConversationPerson => {
    const name = principal.type === "user" ? names[`user:${principal.id}`] : undefined
    return name ? { id: principal.id, name } : { id: principal.id }
  }

  return {
    section: renderConversationPeople({
      owner: personOf(owner),
      participants: participants.map(personOf),
    }),
    byMessageId: new Map(
      authored.map((message) => [
        message.id,
        renderMessageAuthor(personOf(message.authorPrincipal)),
      ])
    ),
  }
}

/** What the authors add to the user messages, for the model input's token estimate. */
export function conversationAuthorsText(authors: ConversationAuthors): string {
  return [...authors.byMessageId.values()].join("\n")
}
