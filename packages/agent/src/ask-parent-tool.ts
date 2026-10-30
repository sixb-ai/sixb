import { type AgentMessage, AgentToolPublicError } from "@sixb/core"
import { assertJsonValue, isJsonObject, type ModelTool } from "@sixb/core/models"
import { agentToolErrorText } from "./model-adapters"
import type { SubagentInbox } from "./subagent-inbox"

export interface AskParentInput {
  readonly question: string
}

/** What `ask_parent` answers: the parent's answer, or that it comes in a later turn. */
export type AskParentOutput =
  | { readonly answer: string }
  /** `question`: its id, which the answer of a later turn replies to. */
  | { readonly status: "deferred"; readonly question: string; readonly note: string }
  /** It paused on a held call too: only a decision continues it, without an answer. */
  | { readonly status: "unanswered"; readonly question: string; readonly note: string }

/** Read by the child only once it continues: its loop pauses right after the step that asked. */
const DEFERRED_NOTE =
  "Your parent's turn ended before it could answer. You continue with its answer, a <sixb_parent_answer> block, once it has one."

const UNANSWERED_NOTE =
  "Your parent's turn ended before it could answer, and you paused on a call that waits for the user's approval: you continue once the user decides, without an answer. Ask again if you still need one."

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
      part.toolName === "ask_parent" &&
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
 * A child's question to its parent, which it waits for within its step. Its parent answers with
 * `message_agent`; when its turn ends first, the child pauses on the question and a later turn
 * continues it with the answer.
 */
export function createAskParentTool(inbox: SubagentInbox): ModelTool<AskParentInput> {
  return {
    name: "ask_parent",
    description: [
      "Ask your parent agent a question and wait for its answer, which this tool returns.",
      "Ask only when you cannot go on without a decision that only your parent or the user can make, never what the project's data or your task answers. One question at a time.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          description: "One short question, with the choices you see when there are some.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    parseInput: parseAskParentInput,
    execute: async ({ question }, { signal, callId, toolCallId }) => {
      const reply = await inbox.ask(question, `${callId}:${toolCallId}`, signal)
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

function parseAskParentInput(value: unknown): AskParentInput {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => key !== "question") ||
    typeof value.question !== "string" ||
    !value.question.trim()
  ) {
    throw new AgentToolPublicError("[SixbAgent] ask_parent expects a non-empty question.")
  }
  return { question: value.question.trim() }
}
