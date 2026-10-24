import { isJsonObject } from "../json"
import type { AgentRunRecord } from "../storage/agents"
import type { AgentMessage } from "./message"

/** A question a sub-agent asked its parent: the id of its mail and what it asks. */
export interface AgentChildQuestion {
  readonly id: string
  readonly text: string
}

/**
 * Whether the child paused on its question when its turn ended: it continues once a later turn of
 * the conversation answers it under its key.
 */
export function isAwaitingAnswerRun(run: AgentRunRecord | null | undefined): boolean {
  return (
    run?.kind === "subagent" && run.status === "succeeded" && run.finishReason === "awaiting_answer"
  )
}

/**
 * The question a run's messages paused on: its `ask_parent` call whose answer was deferred to a
 * later turn, which names the question's id.
 */
export function deferredChildQuestion(
  messages: readonly Pick<AgentMessage, "parts">[]
): AgentChildQuestion | undefined {
  const asked = messages
    .flatMap((message) => message.parts)
    .flatMap((part) =>
      part.type === "tool-call" &&
      part.toolName === "ask_parent" &&
      part.state === "output-available" &&
      isJsonObject(part.output) &&
      part.output.status === "deferred" &&
      isJsonObject(part.input)
        ? [{ input: part.input, output: part.output }]
        : []
    )
    .at(-1)
  if (!asked) return undefined

  const { question: text } = asked.input
  const { question: id } = asked.output
  return typeof text === "string" && typeof id === "string" ? { id, text: text.trim() } : undefined
}
