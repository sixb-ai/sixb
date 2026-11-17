import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ModelAssistantPart,
  type ModelMessage,
  type ModelToolOutput,
} from "@sixb/core/models"
import { messagesInput } from "@sixb/model-protocols/messages"

export const PROVIDER_ID = "claude-code"
export const ERROR_PREFIX = "[SixbClaudeCode]"

/**
 * Where a Claude Code session stands after a call: resuming `sessionId` at the transcript entry
 * `at` continues exactly what the answer was given. Stored in the `providerData` of the answer's
 * last part, which costs no tokens and keeps the conversation estimable for AI usage limits.
 */
export interface ClaudeCodeSessionState {
  readonly sessionId: string
  readonly at: string
}

/**
 * What one call sends to Claude Code: the system prompt, and the user message that continues the
 * conversation, either in the session the last answer came from or in a new one.
 */
export interface ClaudeCodeTurn {
  readonly systemPrompt: string
  /** Absent when no earlier answer came from Claude Code, or the conversation changed since. */
  readonly resume?: {
    readonly session: ClaudeCodeSessionState
    readonly content: readonly JsonObject[]
  }
  /** A new session's first message: the conversation so far as a transcript, then what is new. */
  readonly start: readonly JsonObject[]
}

/**
 * Sixb sends the whole conversation on every call, and Claude Code keeps it in a session. When the
 * last answer carries the session it came from, only what follows it is sent: tool results and the
 * user's next message. A conversation with no such answer, or one Claude Code can no longer resume,
 * starts a session with the earlier messages as a transcript.
 */
export function planTurn(messages: readonly ModelMessage[]): ClaudeCodeTurn {
  const systemPrompt = messages
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n\n")
  const conversation = messages.filter((message) => message.role !== "system")

  let tailStart = conversation.length
  while (tailStart > 0 && conversation[tailStart - 1]?.role !== "assistant") tailStart -= 1
  const history = conversation.slice(0, tailStart)
  const tail = conversation.slice(tailStart)
  if (tail.length === 0) {
    throw new TypeError(`${ERROR_PREFIX} A request must end with a user message or tool results.`)
  }

  const last = history.at(-1)
  const session = last?.role === "assistant" ? sessionState(last.content) : undefined

  return {
    systemPrompt,
    ...(session === undefined ? {} : { resume: { session, content: userContent(tail) } }),
    start: startContent(history, tail),
  }
}

export function sessionState(
  content: readonly ModelAssistantPart[]
): ClaudeCodeSessionState | undefined {
  for (const part of [...content].reverse()) {
    const data = part.type === "provider-state" ? undefined : part.providerData?.[PROVIDER_ID]
    if (!isJsonObject(data)) continue

    const { sessionId, at } = data
    if (typeof sessionId === "string" && sessionId && typeof at === "string" && at) {
      return { sessionId, at }
    }
  }

  return undefined
}

/** User and tool messages as the one user message the Messages API takes in their place. */
function userContent(messages: readonly ModelMessage[]): JsonObject[] {
  const content: JsonObject[] = []
  for (const message of messagesInput(messages, PROVIDER_ID, ERROR_PREFIX).messages) {
    if (Array.isArray(message.content)) content.push(...message.content.filter(isJsonObject))
  }
  return content
}

function startContent(
  history: readonly ModelMessage[],
  tail: readonly ModelMessage[]
): JsonObject[] {
  const toolResults = tail.filter((message) => message.role === "tool")
  const userMessages = tail.filter((message) => message.role === "user")
  if (history.length === 0 && toolResults.length === 0) return userContent(userMessages)

  // A new session holds no tool call for a result to answer, so earlier results are text too.
  const transcript = renderTranscript([...history, ...toolResults])
  const continuation =
    userMessages.length === 0
      ? [{ type: "text", text: "Continue from the tool results above." }]
      : userContent(userMessages)

  return [{ type: "text", text: transcript }, ...continuation]
}

/** The conversation so far, for a session that did not see it. */
export function renderTranscript(messages: readonly ModelMessage[]): string {
  const entries: string[] = []
  for (const message of messages) {
    if (message.role === "system") continue

    if (message.role === "user") {
      const text = message.content
        .map((part) =>
          part.type === "text"
            ? part.text
            : `[file${part.filename ? ` ${part.filename}` : ""}, ${part.mediaType}]`
        )
        .join("\n")
      entries.push(`<user>\n${text}\n</user>`)
      continue
    }

    if (message.role === "tool") {
      for (const part of message.content) {
        entries.push(toolResultEntry(part.toolName, part.toolCallId, part.output))
      }
      continue
    }

    const lines: string[] = []
    for (const part of message.content) {
      if (part.type === "text") lines.push(part.text)
      if (part.type === "tool-call") {
        lines.push(
          `<tool_call name="${part.toolName}" id="${part.toolCallId}">${json(part.input)}</tool_call>`
        )
      }
      if (part.type === "tool-result") {
        lines.push(toolResultEntry(part.toolName, part.toolCallId, part.output))
      }
    }
    if (lines.length > 0) entries.push(`<assistant>\n${lines.join("\n")}\n</assistant>`)
  }

  return [
    "This conversation began before this session. What was said so far, with the tool calls made",
    "and their results written out as text:",
    "",
    "<transcript>",
    ...entries,
    "</transcript>",
  ].join("\n")
}

function toolResultEntry(name: string, id: string, output: ModelToolOutput): string {
  const error = output.type === "error-text" || output.type === "error-json"
  const text =
    output.type === "text" || output.type === "error-text" ? output.value : json(output.value)

  return `<tool_result name="${name}" id="${id}"${error ? ' error="true"' : ""}>${text}</tool_result>`
}

function json(value: JsonValue): string {
  return JSON.stringify(value)
}
