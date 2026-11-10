import type { AgentConversationMessage, AgentConversationTurn } from "../conversation"

/** One question of an `ask` call, as the card shows it. */
export interface AskedQuestion {
  readonly question: string
  readonly choices: readonly string[]
  /** Several of the choices may be picked. */
  readonly multiple: boolean
}

/** The tools an agent asks with: `ask`, and a sub-agent's `ask_parent` in earlier threads. */
export function isAskTool(toolName: string): boolean {
  return toolName === "ask" || toolName === "ask_parent"
}

/** The questions of an `ask` call's input, or of an `ask_parent` call's `{ question }`. */
export function askedQuestions(input: unknown): readonly AskedQuestion[] {
  if (!isRecord(input)) return []
  if (typeof input.question === "string" && input.question.trim()) {
    return [{ question: input.question.trim(), choices: [], multiple: false }]
  }
  if (!Array.isArray(input.questions)) return []
  return input.questions.flatMap((value): AskedQuestion[] => {
    if (!isRecord(value) || typeof value.question !== "string" || !value.question.trim()) return []
    const choices = Array.isArray(value.choices)
      ? value.choices.filter((choice): choice is string => typeof choice === "string" && !!choice)
      : []
    return [
      {
        question: value.question.trim(),
        choices,
        multiple: value.multiple === true && choices.length > 0,
      },
    ]
  })
}

/** The questions as one line, for a row that names them: `Which year? · Which regions?`. */
export function askedText(input: unknown): string {
  return askedQuestions(input)
    .map((question) => question.question)
    .join(" · ")
}

/**
 * The user's answer as the message the card sends: the picked choices or the typed text, and with
 * several questions each answer after its question. Unanswered questions are left out; empty when
 * nothing was answered.
 */
export function answerText(
  questions: readonly AskedQuestion[],
  answers: readonly (readonly string[])[]
): string {
  const answered = questions.flatMap((question, index) => {
    const picked = (answers[index] ?? []).map((answer) => answer.trim()).filter(Boolean)
    return picked.length > 0 ? [{ question: question.question, answer: picked.join(", ") }] : []
  })
  if (questions.length === 1) return answered[0]?.answer ?? ""
  return answered.map(({ question, answer }) => `${question} ${answer}`).join("\n")
}

/**
 * The message whose question still waits for the user: the conversation's last message, a reply
 * that asked, once its turn ended. A later message answers it, and a running turn has not asked
 * yet.
 */
export function openQuestionMessageKey(
  messages: readonly AgentConversationMessage[],
  turn: AgentConversationTurn
): string | null {
  if (turn.kind === "responding") return null
  const last = messages.at(-1)
  if (last?.role !== "assistant") return null
  const asked = last.parts.some(
    (part) => part.type === "tool" && part.toolName === "ask" && part.state === "output-available"
  )
  return asked ? last.key : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
