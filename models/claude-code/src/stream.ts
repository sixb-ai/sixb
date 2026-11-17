import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
  type LanguageModelStreamEvent,
  type ModelFinishReason,
  ModelProviderError,
} from "@sixb/core/models"
import { messagesUsage } from "@sixb/model-protocols/messages"
import { TOOL_PREFIX } from "./tools"
import { ERROR_PREFIX, PROVIDER_ID } from "./turn"

interface Block {
  readonly kind: "text" | "reasoning" | "tool"
  readonly id: string
  /** A tool call's input as streamed so far. */
  input: string
}

type BlockEnd = Extract<
  LanguageModelStreamEvent,
  { readonly type: "text-end" | "reasoning-end" | "tool-input-end" }
>

/** Assistant errors a later attempt can get past. */
const RETRYABLE_ERRORS = new Set(["rate_limit", "overloaded", "server_error"])

/**
 * Turns the messages of one Claude Code query into Sixb model events.
 *
 * With partial messages on, Claude Code forwards each Messages API stream event, so text, reasoning
 * and Sixb's tool calls stream as they arrive. Tool calls Claude Code makes for itself, such as
 * the one that returns structured output, stay inside it. Usage adds up every API call of the
 * query. The answer's last part carries the session in its `providerData`, so the next call can
 * resume it: the session is known only once the answer ends, so the last part's end waits for it.
 */
export class ClaudeCodeStream {
  private readonly blocks = new Map<number, Block>()
  private readonly usage: JsonObject = {}
  private messageId = ""
  private messageUsage: JsonObject = {}
  private messageToolCalls = 0
  private stopReason = ""
  private described = false
  private sessionId: string | undefined
  private lastEntry: string | undefined
  private structuredOutput: JsonValue | undefined
  /** The latest block's end, held until the next block starts or the answer ends. */
  private pendingEnd: BlockEnd | undefined

  /** The last answer called Sixb's tools: the query is waiting for their results. */
  toolCallsReady = false
  /** Claude Code ended the turn. */
  done = false

  constructor(
    private readonly options: {
      readonly modelId: string
      /** The request asked for structured output: only the final output is the answer's text. */
      readonly structuredOutput: boolean
    }
  ) {}

  accept(message: SDKMessage): LanguageModelStreamEvent[] {
    // No subagent runs without Claude Code's own tools; were one to, it is not this answer.
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return []
    if ("session_id" in message && typeof message.session_id === "string") {
      this.sessionId = message.session_id
    }

    if (message.type === "stream_event") return this.acceptEvent(message.event)
    if (message.type === "assistant") {
      this.lastEntry = message.uuid
      if (message.error !== undefined) throw this.assistantError(message.error, message.message)
      return []
    }
    // Results of Claude Code's own tool calls end up in the transcript as user entries.
    if (message.type === "user" && typeof message.uuid === "string") this.lastEntry = message.uuid
    if (message.type === "result") this.acceptResult(message)

    return []
  }

  /** The end of the answer: structured output, the session to resume, and what it used. */
  finish(): LanguageModelStreamEvent[] {
    const events: LanguageModelStreamEvent[] = []
    if (this.structuredOutput !== undefined) {
      const id = "structured-output"
      events.push(
        ...this.flushEnd(),
        { type: "text-start", id },
        { type: "text-delta", id, delta: JSON.stringify(this.structuredOutput) }
      )
      this.pendingEnd = { type: "text-end", id }
    }
    const last = this.pendingEnd
    this.pendingEnd = undefined
    if (last !== undefined) {
      const session =
        this.sessionId === undefined || this.lastEntry === undefined
          ? undefined
          : { [PROVIDER_ID]: { sessionId: this.sessionId, at: this.lastEntry } }
      events.push(session === undefined ? last : { ...last, providerData: session })
    }
    events.push({
      type: "finish",
      finishReason: this.toolCallsReady ? "tool-calls" : this.finishReason(),
      ...(this.stopReason ? { rawFinishReason: this.stopReason } : {}),
      ...(this.stopReason === "model_context_window_exceeded"
        ? { contextWindowExceeded: true }
        : {}),
      usage: messagesUsage(this.usage),
    })

    return events
  }

  private acceptEvent(event: unknown): LanguageModelStreamEvent[] {
    if (!isJsonObject(event)) return []
    const index = typeof event.index === "number" ? event.index : -1

    switch (event.type) {
      case "message_start":
        return this.startMessage(object(event.message))
      case "content_block_start":
        return this.startBlock(index, object(event.content_block))
      case "content_block_delta":
        return this.deltaBlock(index, object(event.delta))
      case "content_block_stop":
        return this.stopBlock(index)
      case "message_delta":
        this.stopReason = string(object(event.delta)?.stop_reason) || this.stopReason
        this.messageUsage = { ...this.messageUsage, ...object(event.usage) }
        return []
      case "message_stop":
        addUsage(this.usage, this.messageUsage)
        this.toolCallsReady = this.stopReason === "tool_use" && this.messageToolCalls > 0
        return []
      default:
        return []
    }
  }

  private startMessage(message: JsonObject | undefined): LanguageModelStreamEvent[] {
    this.messageId = string(message?.id)
    this.messageUsage = object(message?.usage) ?? {}
    this.messageToolCalls = 0
    this.stopReason = ""
    this.blocks.clear()
    if (this.described) return []

    this.described = true
    const modelId = string(message?.model)
    return [
      {
        type: "response-metadata",
        ...(this.messageId
          ? { id: this.messageId, providerIds: { responseId: this.messageId } }
          : {}),
        ...(modelId ? { modelId } : {}),
      },
    ]
  }

  private startBlock(index: number, block: JsonObject | undefined): LanguageModelStreamEvent[] {
    const id = `${this.messageId}:${index}`

    if (block?.type === "text" && !this.options.structuredOutput) {
      this.blocks.set(index, { kind: "text", id, input: "" })
      return [...this.flushEnd(), { type: "text-start", id }]
    }
    if (block?.type === "thinking") {
      this.blocks.set(index, { kind: "reasoning", id, input: "" })
      return [...this.flushEnd(), { type: "reasoning-start", id }]
    }

    const name = string(block?.name)
    const toolCallId = string(block?.id)
    if (block?.type === "tool_use" && name.startsWith(TOOL_PREFIX) && toolCallId) {
      const toolName = name.slice(TOOL_PREFIX.length)
      this.blocks.set(index, { kind: "tool", id: toolCallId, input: "" })
      this.messageToolCalls += 1
      return [...this.flushEnd(), { type: "tool-input-start", id: toolCallId, toolName }]
    }

    return []
  }

  private deltaBlock(index: number, delta: JsonObject | undefined): LanguageModelStreamEvent[] {
    const block = this.blocks.get(index)
    if (block === undefined) return []

    if (block.kind === "text" && delta?.type === "text_delta") {
      return [{ type: "text-delta", id: block.id, delta: string(delta.text) }]
    }
    if (block.kind === "reasoning" && delta?.type === "thinking_delta") {
      return [{ type: "reasoning-delta", id: block.id, delta: string(delta.thinking) }]
    }
    if (block.kind === "tool" && delta?.type === "input_json_delta") {
      const part = string(delta.partial_json)
      block.input += part
      return [{ type: "tool-input-delta", id: block.id, delta: part }]
    }

    return []
  }

  private stopBlock(index: number): LanguageModelStreamEvent[] {
    const block = this.blocks.get(index)
    if (block === undefined) return []
    this.blocks.delete(index)

    const events = this.flushEnd()
    if (block.kind === "text") this.pendingEnd = { type: "text-end", id: block.id }
    if (block.kind === "reasoning") this.pendingEnd = { type: "reasoning-end", id: block.id }
    if (block.kind === "tool") {
      // A call without arguments streams none: its input is still an object.
      if (!block.input) events.push({ type: "tool-input-delta", id: block.id, delta: "{}" })
      this.pendingEnd = { type: "tool-input-end", id: block.id }
    }
    return events
  }

  private flushEnd(): LanguageModelStreamEvent[] {
    const end = this.pendingEnd
    this.pendingEnd = undefined
    return end === undefined ? [] : [end]
  }

  private acceptResult(result: SDKResultMessage) {
    if (result.subtype === "success" && !result.is_error) {
      this.done = true
      if (result.structured_output !== undefined && isJsonValue(result.structured_output)) {
        this.structuredOutput = result.structured_output
      }
      return
    }

    const detail =
      result.subtype === "success" ? result.result : result.errors.join(" ") || result.subtype
    throw new ModelProviderError(
      `${ERROR_PREFIX} Claude Code failed: ${detail || "no reason given."}`,
      PROVIDER_ID,
      this.options.modelId,
      { code: result.subtype }
    )
  }

  private assistantError(code: string, message: unknown): ModelProviderError {
    const content = isJsonObject(message) && Array.isArray(message.content) ? message.content : []
    const text = content
      .flatMap((block) =>
        isJsonObject(block) && block.type === "text" ? [string(block.text)] : []
      )
      .join(" ")
    const detail =
      code === "authentication_failed"
        ? "Claude Code is not signed in here: on a computer, run `claude` and sign in with /login; on a server, set CLAUDE_CODE_OAUTH_TOKEN to a token from `claude setup-token`."
        : text || `Claude Code reported '${code}'.`

    return new ModelProviderError(`${ERROR_PREFIX} ${detail}`, PROVIDER_ID, this.options.modelId, {
      code,
      retryable: RETRYABLE_ERRORS.has(code),
    })
  }

  private finishReason(): ModelFinishReason {
    switch (this.stopReason) {
      case "end_turn":
      case "stop_sequence":
      // Claude Code's own tool calls, such as the structured output's, end its turn.
      case "tool_use":
        return "stop"
      case "max_tokens":
      case "model_context_window_exceeded":
        return "length"
      case "refusal":
        return "content-filter"
      case "pause_turn":
        return "pause"
      case "":
        return "unknown"
      default:
        return "other"
    }
  }
}

/** Adds one API call's usage into the query's: counters add up, nested breakdowns too. */
function addUsage(total: JsonObject, next: JsonObject) {
  for (const [key, value] of Object.entries(next)) {
    const current = total[key]
    if (typeof value === "number") {
      total[key] = (typeof current === "number" ? current : 0) + value
    } else if (isJsonObject(value)) {
      const nested = isJsonObject(current) ? current : {}
      addUsage(nested, value)
      total[key] = nested
    }
  }
}

function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function string(value: unknown): string {
  return typeof value === "string" ? value : ""
}
