import { type AgentMessage, AgentToolPublicError } from "@sixb/core"
import {
  AGENT_QUESTION_LIMITS,
  type AgentQuestion,
  agentQuestionsText,
  isChildAskTool,
} from "@sixb/core/internal/agents"
import { assertJsonValue, isJsonObject, type JsonObject, type ModelTool } from "@sixb/core/models"
import { agentToolErrorText } from "./model-adapters"
import type { SubagentInbox } from "./subagent-inbox"

export const ASK_TOOL_NAME = "ask"

export interface AskInput {
  readonly questions: readonly AgentQuestion[]
}

/** What a sub-agent's `ask` answers: its parent's answer, or that it comes in a later turn. */
export type AskParentOutput =
  | { readonly answer: string }
  /** `question`: its id, which the answer of a later turn replies to. */
  | { readonly status: "deferred"; readonly question: string; readonly note: string }
  /** It paused on a held call too: only a decision continues it, without an answer. */
  | { readonly status: "unanswered"; readonly question: string; readonly note: string }

/** What the Agent's `ask` answers: the user sees the questions, and the turn ends. */
export interface AskUserOutput {
  readonly status: "asked"
  readonly note: string
}

/** Read by the child only once it continues: its loop pauses right after the step that asked. */
const DEFERRED_NOTE =
  "Your parent's turn ended before it could answer. You continue with its answer, a <sixb_parent_answer> block, once it has one."

const UNANSWERED_NOTE =
  "Your parent's turn ended before it could answer, and you paused on a call that waits for the user's approval: you continue once the user decides, without an answer. Ask again if you still need one."

const ASKED_NOTE = "The user sees your questions. Their answer comes as their next message."

/**
 * What a question deferred in the step that held a call reads as once the child continues: the
 * decision continues it, and no answer comes with it. Only a continuation reads it, as the child
 * paused right after that step, so what its thread keeps may say so without changing a byte the
 * model already read.
 */
export function unansweredQuestion<TMessage extends Pick<AgentMessage, "parts">>(
  messages: readonly TMessage[]
): readonly TMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.type === "tool-call" &&
      isChildAskTool(part.toolName) &&
      part.state === "output-available" &&
      isJsonObject(part.output) &&
      part.output.status === "deferred" &&
      typeof part.output.question === "string"
        ? {
            ...part,
            output: { status: "unanswered", question: part.output.question, note: UNANSWERED_NOTE },
          }
        : part
    ),
  }))
}

/**
 * A sub-agent's questions to its parent, which it waits for within its step. Its parent reads them
 * as one text and answers with `message_agent`; when its turn ends first, the child pauses on them
 * and a later turn continues it with the answer.
 */
export function createAskParentTool(inbox: SubagentInbox): ModelTool<AskInput> {
  return {
    name: ASK_TOOL_NAME,
    strict: true,
    description: [
      "Ask your parent agent, and wait for its answer, which this tool returns.",
      "Ask only when you cannot go on without a decision that only your parent or the user can make, never what the project's data or your task answers. Put related questions in one call.",
    ].join("\n"),
    inputSchema: askInputSchema(),
    parseInput: parseAskInput,
    execute: async ({ questions }, { signal, callId, toolCallId }) => {
      const reply = await inbox.ask(
        agentQuestionsText(questions),
        `${callId}:${toolCallId}`,
        signal
      )
      const output: AskParentOutput =
        reply.kind === "answer"
          ? { answer: reply.text }
          : { status: "deferred", question: reply.questionId, note: DEFERRED_NOTE }
      assertJsonValue(output)
      return output
    },
    errorText: agentToolErrorText,
  }
}

/**
 * The Agent's questions to the user. The turn ends after the step that asks (see
 * {@link stepAskedUser}); the app and the TUI show the questions with their choices, and the
 * user's answer is their next message, which the next turn reads after this call.
 */
export function createAskUserTool(): ModelTool<AskInput> {
  return {
    name: ASK_TOOL_NAME,
    strict: true,
    description: [
      "Ask the user, and end your turn: they see your questions with their choices, and their answer comes as their next message.",
      "Ask only when you cannot go on without an answer only the user can give, never what the conversation, the project's data or the task answers: otherwise make a reasonable assumption and say it. Put related questions in one call.",
    ].join("\n"),
    inputSchema: askInputSchema(),
    parseInput: parseAskInput,
    execute: async () => {
      const output: AskUserOutput = { status: "asked", note: ASKED_NOTE }
      return { ...output }
    },
    errorText: agentToolErrorText,
  }
}

/**
 * Whether a step of the Agent's asked the user: the turn ends after it. A call refused for its
 * input did not ask: the model reads why and tries again.
 */
export function stepAskedUser(step: {
  readonly content: readonly {
    readonly type: string
    readonly toolName?: string
    readonly output?: { readonly type: string }
  }[]
}): boolean {
  return step.content.some(
    (part) =>
      part.type === "tool-result" && part.toolName === ASK_TOOL_NAME && part.output?.type === "json"
  )
}

function askInputSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: AGENT_QUESTION_LIMITS.questions,
        description: `One to ${AGENT_QUESTION_LIMITS.questions} questions, asked together.`,
        items: {
          type: "object",
          properties: {
            question: { type: "string", minLength: 1, description: "One short question." },
            choices: {
              type: "array",
              maxItems: AGENT_QUESTION_LIMITS.choices,
              items: { type: "string", minLength: 1 },
              description: `Up to ${AGENT_QUESTION_LIMITS.choices} answers to pick from, when there are a few. A typed answer is always possible.`,
            },
            multiple: {
              type: "boolean",
              description: "Several of the choices may be picked. Default: false.",
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  }
}

function parseAskInput(value: unknown): AskInput {
  if (!isJsonObject(value) || Object.keys(value).some((key) => key !== "questions")) {
    throw askError("ask expects { questions: [...] }.")
  }
  const { questions } = value
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.length > AGENT_QUESTION_LIMITS.questions
  ) {
    throw askError(`ask expects 1 to ${AGENT_QUESTION_LIMITS.questions} questions.`)
  }
  return {
    questions: questions.map((entry, index): AgentQuestion => {
      const at = `questions[${index}]`
      if (
        !isJsonObject(entry) ||
        Object.keys(entry).some((key) => !["question", "choices", "multiple"].includes(key))
      ) {
        throw askError(`${at} must be { question, choices?, multiple? }.`)
      }
      if (typeof entry.question !== "string" || !entry.question.trim()) {
        throw askError(`${at}.question must be a non-empty question.`)
      }
      const choices = entry.choices ?? []
      if (
        !Array.isArray(choices) ||
        choices.length > AGENT_QUESTION_LIMITS.choices ||
        choices.some((choice) => typeof choice !== "string" || !choice.trim())
      ) {
        throw askError(
          `${at}.choices must be up to ${AGENT_QUESTION_LIMITS.choices} non-empty answers.`
        )
      }
      if (entry.multiple !== undefined && typeof entry.multiple !== "boolean") {
        throw askError(`${at}.multiple must be true or false.`)
      }
      const picked = (choices as string[]).map((choice) => choice.trim())
      return {
        question: entry.question.trim(),
        ...(picked.length > 0 ? { choices: picked } : {}),
        ...(entry.multiple === true && picked.length > 0 ? { multiple: true } : {}),
      }
    }),
  }
}

function askError(message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] ${message}`)
}
