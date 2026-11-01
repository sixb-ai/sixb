import { expect } from "bun:test"
import type { Storage } from "@sixb/core"
import type { LanguageModelRequest } from "@sixb/core/models"
import type { AgentStorage } from "@sixb/core/storage"
import { messagesInput } from "../../../models/protocols/src/messages"
import { responsesInput } from "../../../models/protocols/src/responses"

/**
 * A storage that hands messages back as Postgres `jsonb` does: every object in their parts with its
 * keys shorter first, then bytewise. SQLite and the in-memory storage keep the order written.
 */
export function withJsonbKeyOrder<TStorage extends Storage>(storage: TStorage): TStorage {
  const messages = (target: AgentStorage["messages"]): AgentStorage["messages"] =>
    overriding(target, {
      append: (input: Parameters<AgentStorage["messages"]["append"]>[0]) =>
        target.append({ ...input, parts: jsonbOrder(input.parts) as typeof input.parts }),
    })
  const agents = (target: AgentStorage): AgentStorage =>
    overriding(target, { messages: messages(target.messages) })
  const view = <T extends Storage>(target: T): T => {
    const members: Partial<Storage> = {
      ...(target.agents ? { agents: agents(target.agents) } : {}),
      transaction: (run, options) => target.transaction((tx) => run(view(tx)), options),
    }
    return overriding(target, members as Partial<T>)
  }

  return view(storage)
}

/** `target` with some members replaced, its own methods still bound to it. */
function overriding<T extends object>(target: T, members: Partial<T>): T {
  return new Proxy(target, {
    get(target, property) {
      if (Object.hasOwn(members, property)) return members[property as keyof T]
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder)
  if (value === null || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.length - right.length || (left < right ? -1 : 1))
      .map(([key, entry]) => [key, jsonbOrder(entry)])
  )
}

/**
 * The request a later call sends starts with every item of an earlier one, byte for byte, as the
 * Responses and Messages protocols serialize them: the provider's prompt cache reads it through.
 */
export function expectReplayedPrefix(
  earlier: LanguageModelRequest | undefined,
  later: LanguageModelRequest | undefined,
  providerId: string
): void {
  if (!earlier || !later) throw new Error("[test] Expected both requests.")

  const responses = (request: LanguageModelRequest) =>
    responsesInput(request.messages, providerId).map((item) => JSON.stringify(item))
  const before = responses(earlier)
  expect(responses(later).slice(0, before.length)).toEqual(before)

  const messages = (request: LanguageModelRequest) => {
    const input = messagesInput(request.messages, providerId, "[test]")
    return [JSON.stringify(input.system), ...input.messages.map((item) => JSON.stringify(item))]
  }
  const sent = messages(earlier)
  expect(messages(later).slice(0, sent.length)).toEqual(sent)
}
