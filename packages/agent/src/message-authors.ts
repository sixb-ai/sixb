import { type Principal, principalsEqual, type UserPrincipal } from "@sixb/core"
import type { AgentRunPeople } from "@sixb/core/internal/agents"
import type {
  AgentMessageRecord,
  AgentThreadParticipantRecord,
  AgentThreadRecord,
} from "@sixb/core/storage"
import {
  type ConversationPerson,
  renderConversationPeople,
  renderMessageAuthor,
} from "./agent-prompt"

/** What the model reads of who writes in a conversation. Nothing of it is stored or shown. */
export interface ConversationAuthors {
  /** Who takes part, for the newest user message only; absent in a one-person conversation. */
  readonly section?: string
  /** The `<sixb_author>` closing each retained user message, by message id. */
  readonly byMessageId: ReadonlyMap<string, string>
}

const ALONE: ConversationAuthors = { byMessageId: new Map() }

/** A thread with the participants who can read it now: the people the model is told about. */
export interface ConversationReaders {
  readonly thread: AgentThreadRecord
  readonly participants: readonly UserPrincipal[]
}

/**
 * The participants who can read the thread now: active users the project's roles let use the
 * Agent. Someone added before losing access is not named to the model as taking part.
 */
export async function conversationReaders(input: {
  readonly people: Pick<AgentRunPeople, "user" | "canRunAgent">
  readonly thread: AgentThreadRecord
  readonly participants: readonly AgentThreadParticipantRecord[]
}): Promise<ConversationReaders> {
  const { people, thread } = input
  const readers = await Promise.all(
    input.participants.map(async ({ principal }) => {
      const user = await people.user(principal.id)
      if (user?.status !== "active") return null

      const allowed = await people.canRunAgent(principal.id)
      return allowed ? principal : null
    })
  )
  return { thread, participants: readers.filter((reader) => reader !== null) }
}

/**
 * Who wrote each retained user message, when the thread has participants or several people wrote
 * in it; nothing in a conversation its owner holds alone, so its messages do not change.
 *
 * Each message's author derives from stored data, so a turn replays the bytes the previous one
 * sent. They change only when someone renames their account. The section naming who takes part
 * rides on the newest user message: on the next turn only that message, the history's tail, loses
 * it.
 */
export async function loadConversationAuthors(input: {
  readonly people: Pick<AgentRunPeople, "user">
  readonly conversation: ConversationReaders
  readonly messages: readonly AgentMessageRecord[]
}): Promise<ConversationAuthors> {
  const { thread, participants } = input.conversation

  const authored = input.messages.filter(
    (message): message is AgentMessageRecord & { authorPrincipal: Principal } =>
      message.role === "user" && message.authorPrincipal !== undefined
  )
  const owner = thread.ownerPrincipal
  const someoneElseWrote = authored.some(
    (message) => !principalsEqual(message.authorPrincipal, owner)
  )
  if (participants.length === 0 && !someoneElseWrote) return ALONE

  const people = await namePeople(input.people, [
    owner,
    ...participants,
    ...authored.map((message) => message.authorPrincipal),
  ])
  const personOf = (principal: Principal) => people.get(key(principal)) ?? { id: principal.id }

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

/** Everything the authors add to the model input, for its token estimate. */
export function conversationAuthorsText(authors: ConversationAuthors): string {
  return [authors.section ?? "", ...authors.byMessageId.values()].join("\n")
}

/** Each user's display name; anyone else, or a user without one, goes by their id. */
async function namePeople(
  people: Pick<AgentRunPeople, "user">,
  principals: readonly Principal[]
): Promise<ReadonlyMap<string, ConversationPerson>> {
  const unique = new Map(principals.map((principal) => [key(principal), principal]))

  const named = await Promise.all(
    [...unique.entries()].map(async ([principalKey, principal]) => {
      const user = principal.type === "user" ? await people.user(principal.id) : null

      const person: ConversationPerson = user?.displayName
        ? { id: principal.id, name: user.displayName }
        : { id: principal.id }
      return [principalKey, person] as const
    })
  )

  return new Map(named)
}

function key(principal: Principal): string {
  return `${principal.type}:${principal.id}`
}
