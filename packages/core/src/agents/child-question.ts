import { isJsonObject, type JsonValue } from "../json"
import type { AgentRunRecord } from "../storage/agents"
import type { AgentMessage } from "./message"

/** A question a sub-agent asked its parent: the id of its mail and what it asks. */
export interface AgentChildQuestion {
  readonly id: string
  readonly text: string
}

/** One question of an `ask` call: what it asks, and the answers it offers. */
export interface AgentQuestion {
  readonly question: string
  /** At most four; a typed answer is always possible beside them. */
  readonly choices?: readonly string[]
  /** Several of the choices may be picked. */
  readonly multiple?: boolean
}

/** The most questions one `ask` holds, and the most choices one question offers. */
export const AGENT_QUESTION_LIMITS = { questions: 4, choices: 4 } as const

/**
 * An `ask` call's questions as one text: what a sub-agent's parent reads of them, and how its
 * thread names the question it paused on.
 *
 * ```text
 * Which environment should I deploy to? (staging / production)
 *
 * 1. Which environment should I deploy to? (staging / production)
 * 2. Which reports? (any of: daily / weekly)
 * ```
 */
export function agentQuestionsText(questions: readonly AgentQuestion[]): string {
  const lines = questions.map((question) => {
    const choices = question.choices?.length
      ? ` (${question.multiple ? "any of: " : ""}${question.choices.join(" / ")})`
      : ""
    return `${question.question}${choices}`
  })
  return lines.length === 1
    ? (lines[0] ?? "")
    : lines.map((line, i) => `${i + 1}. ${line}`).join("\n")
}

/**
 * The questions of an `ask` call's input, or of an `ask_parent` call's, which earlier threads hold:
 * `{ question }` reads as one question. Undefined when the input names none.
 */
export function agentQuestionsOf(
  input: JsonValue | undefined
): readonly AgentQuestion[] | undefined {
  if (!isJsonObject(input)) return undefined
  if (typeof input.question === "string") return [{ question: input.question.trim() }]
  if (!Array.isArray(input.questions)) return undefined

  const questions = input.questions.flatMap((value): AgentQuestion[] => {
    if (!isJsonObject(value) || typeof value.question !== "string") return []
    const choices = Array.isArray(value.choices)
      ? value.choices.filter((choice): choice is string => typeof choice === "string")
      : []
    return [
      {
        question: value.question.trim(),
        ...(choices.length > 0 ? { choices } : {}),
        ...(value.multiple === true ? { multiple: true } : {}),
      },
    ]
  })
  return questions.length > 0 ? questions : undefined
}

/** The tools a sub-agent asks its parent with: `ask`, and `ask_parent`, which earlier threads hold. */
export function isChildAskTool(toolName: string): boolean {
  return toolName === "ask" || toolName === "ask_parent"
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
 * The question a run's messages paused on: its `ask` call whose answer was deferred to a later
 * turn, which names the question's id.
 */
export function deferredChildQuestion(
  messages: readonly Pick<AgentMessage, "parts">[]
): AgentChildQuestion | undefined {
  const asked = messages
    .flatMap((message) => message.parts)
    .flatMap((part) =>
      part.type === "tool-call" &&
      isChildAskTool(part.toolName) &&
      part.state === "output-available" &&
      isJsonObject(part.output) &&
      part.output.status === "deferred"
        ? [{ input: part.input, output: part.output }]
        : []
    )
    .at(-1)
  if (!asked) return undefined

  const questions = agentQuestionsOf(asked.input)
  const { question: id } = asked.output
  return questions && typeof id === "string"
    ? { id, text: agentQuestionsText(questions) }
    : undefined
}
