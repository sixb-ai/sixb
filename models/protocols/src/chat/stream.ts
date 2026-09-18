import {
  type JsonObject,
  type LanguageModelStreamEvent,
  type ModelFinishReason,
  ModelProviderError,
  type ModelUsage,
} from "@sixb/core/models"
import { integer, object } from "../json"
import { decodeServerSentEvents } from "../sse"

export interface ChatStreamOptions {
  readonly providerId: string
  readonly modelId: string
  readonly requestId?: string
  readonly errorPrefix: string
  readonly usage: (raw: JsonObject | undefined) => ModelUsage
}

interface Tool {
  id?: string
  name: string
  arguments: string
}

/** One choice per call. A choice finish is not stream completion: usage/filters can follow it. */
export async function* chatEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: ChatStreamOptions
): AsyncIterable<LanguageModelStreamEvent> {
  const error = (message: string, code?: string) =>
    new ModelProviderError(
      `${options.errorPrefix} ${message}`,
      options.providerId,
      options.modelId,
      { requestId: options.requestId, code }
    )
  const tools = new Map<number, Tool>()
  const annotations: JsonObject[] = []
  let annotationBytes = 0
  let buffered = 0
  let reasoning = ""
  let textStarted = false
  let reasoningStarted = false
  let refusal = ""
  let finish: string | undefined
  let rawUsage: JsonObject | undefined
  let model: string | undefined
  let responseId: string | undefined
  yield { type: "stream-start" }
  if (options.requestId)
    yield { type: "response-metadata", providerIds: { requestId: options.requestId } }
  for await (const event of decodeServerSentEvents(body, signal)) {
    if (event.data.trim() === "[DONE]") {
      if (!finish) throw error("Chat stream ended without a choice finish reason.")
      if (textStarted) yield { type: "text-end", id: "text" }
      if (reasoningStarted)
        yield {
          type: "reasoning-end",
          id: "reasoning",
          providerData: { [options.providerId]: { reasoning_content: reasoning } },
        }
      const ids = new Set<string>()
      for (const tool of tools.values()) {
        if (finish !== "tool_calls" || refusal) continue
        if (!tool.id || !tool.name)
          throw error("Chat tool call is missing its id or function name.")
        if (ids.has(tool.id)) throw error("Chat tool call IDs must be unique.")
        ids.add(tool.id)
        // Truncated/filtered arguments are not executable calls. Preserve accounting at finish.
        yield { type: "tool-call", toolCallId: tool.id, toolName: tool.name, input: tool.arguments }
      }
      if (finish === "tool_calls" && !tools.size)
        throw error("Chat tool_calls finish has no tool calls.")
      yield {
        type: "finish",
        finishReason: refusal ? "content-filter" : finishReason(finish),
        rawFinishReason: finish,
        usage: options.usage(rawUsage),
        ...(model ? { route: { modelId: model } } : {}),
        providerData: {
          [options.providerId]: {
            ...(annotations.length ? { annotations } : {}),
            ...(refusal ? { refusal } : {}),
          },
        },
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      throw error("Provider emitted invalid Chat SSE JSON.")
    }
    const chunk = object(parsed)
    if (!chunk) throw error("Chat SSE data must be an object.")
    if (chunk.error !== undefined || event.event === "error") {
      const detail = object(chunk.error) ?? chunk
      yield {
        type: "error",
        error: error(
          typeof detail.message === "string" ? detail.message : "Chat response failed.",
          typeof detail.code === "string" ? detail.code : undefined
        ),
      }
      return
    }
    const metadata: { id?: string; modelId?: string } = {}
    for (const key of ["id", "model"] as const) {
      const value = chunk[key]
      if (value === undefined || value === "") continue
      if (typeof value !== "string") throw error(`Chat ${key} must be a string.`)
      const previous = key === "id" ? responseId : model
      if (previous && value !== previous) throw error(`Chat ${key} changed within one response.`)
      if (!previous) {
        if (key === "id") {
          responseId = value
          metadata.id = value
        } else {
          model = value
          metadata.modelId = value
        }
      }
    }
    if (Object.keys(metadata).length)
      yield {
        type: "response-metadata",
        ...metadata,
        providerIds: {
          ...(responseId ? { responseId } : {}),
          ...(options.requestId ? { requestId: options.requestId } : {}),
        },
      }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      const usage = object(chunk.usage)
      if (!usage) throw error("Chat usage must be an object.")
      rawUsage = usage
    }
    const note = (source: JsonObject, keys: string[], choice?: number) => {
      const fields: JsonObject = {}
      for (const key of keys) if (source[key] !== undefined) fields[key] = source[key]
      if (!Object.keys(fields).length) return
      annotationBytes += JSON.stringify(fields).length
      if (annotationBytes > 1024 * 1024 || annotations.length >= 1024)
        throw error("Chat filter annotations exceeded the buffer limit.")
      annotations.push({ ...(choice === undefined ? {} : { choice }), ...fields })
    }
    note(chunk, ["prompt_filter_results", "prompt_annotations", "content_filter_results"])
    if (!Array.isArray(chunk.choices)) throw error("Chat chunk is missing its choices array.")
    for (const rawChoice of chunk.choices) {
      const choice = object(rawChoice)
      if (!choice || choice.index !== 0 || chunk.choices.length !== 1)
        throw error("Chat supports exactly one choice (index 0).")
      note(
        choice,
        ["content_filter_results", "content_filter_raw", "content_filter_offsets", "logprobs"],
        0
      )
      const delta = object(choice.delta)
      if (choice.delta !== undefined && choice.delta !== null && !delta)
        throw error("Chat delta must be an object.")
      if (delta) {
        if (delta.role !== undefined && delta.role !== null && delta.role !== "assistant")
          throw error("Chat delta role must be assistant.")
        if (delta.function_call !== undefined || delta.audio !== undefined)
          throw error("Chat legacy function calls and output audio are unsupported.")
        note(delta, ["annotations"], 0)
        for (const key of ["content", "reasoning_content", "refusal"] as const) {
          const value = delta[key]
          if (value === undefined || value === null || value === "") continue
          if (typeof value !== "string") throw error(`Chat ${key} delta must be a string.`)
          if (finish) throw error("Chat content arrived after the choice finished.")
          if (key === "content") {
            if (!textStarted) {
              textStarted = true
              yield { type: "text-start", id: "text" }
            }
            yield { type: "text-delta", id: "text", delta: value }
          } else {
            buffered += value.length
            if (buffered > 8 * 1024 * 1024)
              throw error("Chat replay/tool data exceeded the buffer limit.")
            if (key === "refusal") refusal += value
            else {
              reasoning += value
              if (!reasoningStarted) {
                reasoningStarted = true
                yield { type: "reasoning-start", id: "reasoning" }
              }
              yield { type: "reasoning-delta", id: "reasoning", delta: value }
            }
          }
        }
        if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
          if (finish || !Array.isArray(delta.tool_calls)) throw error("Invalid Chat tool delta.")
          for (const raw of delta.tool_calls) {
            const item = object(raw)
            const index = integer(item?.index)
            if (
              !item ||
              index === undefined ||
              index >= 128 ||
              (item.type !== undefined && item.type !== "function")
            )
              throw error("Invalid Chat function tool index/type.")
            const tool = tools.get(index) ?? { name: "", arguments: "" }
            if (item.id !== undefined && item.id !== null) {
              if (typeof item.id !== "string" || !item.id || (tool.id && tool.id !== item.id))
                throw error("Invalid or conflicting Chat tool id.")
              if (!tool.id) buffered += item.id.length
              if (buffered > 8 * 1024 * 1024)
                throw error("Chat replay/tool data exceeded the buffer limit.")
              tool.id = item.id
            }
            const fn = item.function === undefined ? {} : object(item.function)
            if (!fn) throw error("Chat tool function fields must be an object.")
            for (const key of ["name", "arguments"] as const) {
              const value = fn[key]
              if (value === undefined || value === null) continue
              if (typeof value !== "string") throw error(`Chat tool ${key} must be a string.`)
              // Some Chat backends append an empty-string terminator after an already
              // complete object. It adds no arguments; don't turn {} into invalid {}"".
              // Empty strings inside an unfinished object remain ordinary JSON deltas.
              if (key === "arguments" && value === '""' && completeObject(tool.arguments)) continue
              tool[key] += value
              buffered += value.length
              if (buffered > 8 * 1024 * 1024)
                throw error("Chat replay/tool data exceeded the buffer limit.")
            }
            tools.set(index, tool)
          }
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== "string" || !choice.finish_reason || finish)
          throw error("Invalid or duplicate Chat finish reason.")
        finish = choice.finish_reason
      }
    }
  }
  throw error("Chat stream ended without [DONE].")
}

function completeObject(input: string): boolean {
  try {
    return object(JSON.parse(input)) !== undefined
  } catch {
    return false
  }
}

function finishReason(reason: string): ModelFinishReason {
  if (reason === "stop") return "stop"
  if (reason === "length") return "length"
  if (reason === "content_filter") return "content-filter"
  if (reason === "tool_calls") return "tool-calls"
  return "other"
}
