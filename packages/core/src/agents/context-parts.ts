import type { JsonValue } from "../json"
import { stableJsonStringify } from "../json"
import type { ModelMessage, ModelToolSpecification } from "../models"
import { agentContextFileKind } from "./context-files"
import { AGENT_IMAGE_INPUT_TOKENS } from "./inline-images"
import type {
  AgentContextPartBytes,
  AgentContextPartName,
  AgentHistoryPartName,
  AgentStepRequestSize,
  AgentSystemPromptPartName,
} from "./message"
import { isAgentThreadSummaryText } from "./thread-context-projection"

/** The parts in the order a context meter lists them. */
export const AGENT_CONTEXT_PARTS: readonly AgentContextPartName[] = [
  "system",
  "instructions",
  "memory",
  "skills",
  "ontology",
  "tools",
  "summary",
  "messages",
  "toolResults",
  "files",
]

/** A system prompt as rendered, and its UTF-8 bytes by section. */
export interface AgentSystemPromptSize {
  readonly text: string
  readonly bytes: AgentContextPartBytes<AgentSystemPromptPartName>
}

/**
 * What one model call's request carries, part by part, as it is sent: the system prompt by the
 * sections it was rendered with (any other system text is Sixb's own), the tool definitions, and
 * the history. A file the agent read with read or view_file under `contextDirectory` counts as
 * what it is; an attachment's text counts with the files; images count apart.
 */
export function measureAgentStepRequest(input: {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly Pick<ModelToolSpecification, "name" | "description" | "inputSchema">[]
  readonly systemPrompt?: AgentSystemPromptSize
  readonly contextDirectory?: string
}): AgentStepRequestSize {
  const system: { [Part in AgentSystemPromptPartName]?: number } = {}
  const history: { [Part in AgentHistoryPartName]?: number } = {}
  let images = 0
  const add = <TPart extends string>(
    into: { [Part in TPart]?: number },
    part: TPart,
    bytes: number
  ) => {
    if (bytes > 0) into[part] = (into[part] ?? 0) + bytes
  }

  // What each call asked, for its result to count as the file it read.
  const calls = new Map<string, { readonly toolName: string; readonly input: JsonValue }>()
  for (const message of input.messages) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool-call") calls.set(part.toolCallId, part)
    }
  }
  const resultPart = (toolCallId: string): AgentHistoryPartName => {
    const call = calls.get(toolCallId)
    return (call && agentContextFileKind(call, input.contextDirectory)) ?? "toolResults"
  }

  for (const message of input.messages) {
    switch (message.role) {
      case "system":
        if (input.systemPrompt && message.content === input.systemPrompt.text) {
          for (const [part, bytes] of Object.entries(input.systemPrompt.bytes)) {
            add(system, part as AgentSystemPromptPartName, bytes ?? 0)
          }
        } else {
          add(system, "system", utf8Bytes(message.content))
        }
        break
      case "user":
        for (const part of message.content) {
          if (part.type === "file") {
            if (part.mediaType.toLowerCase().startsWith("image/")) images += 1
            else add(history, "files", utf8Bytes(`${part.filename ?? ""} ${part.mediaType}`))
          } else if (isAgentThreadSummaryText(part.text)) {
            add(history, "summary", utf8Bytes(part.text))
          } else {
            add(
              history,
              part.text.startsWith("<attachment ") ? "files" : "messages",
              utf8Bytes(part.text)
            )
          }
        }
        break
      case "assistant":
        for (const part of message.content) {
          switch (part.type) {
            case "text":
            case "reasoning":
              add(history, "messages", utf8Bytes(part.text))
              break
            case "provider-state":
              add(history, "messages", utf8Bytes(stableJsonStringify(part.data)))
              break
            case "tool-call":
              add(
                history,
                "messages",
                utf8Bytes(part.toolName) + utf8Bytes(stableJsonStringify(part.input))
              )
              break
            case "tool-result":
              add(history, resultPart(part.toolCallId), toolResultBytes(part.output))
              break
          }
        }
        break
      case "tool":
        for (const part of message.content) {
          add(history, resultPart(part.toolCallId), toolResultBytes(part.output))
        }
        break
    }
  }

  return {
    system,
    tools: {
      count: input.tools.length,
      bytes: input.tools.reduce(
        (bytes, tool) =>
          bytes +
          utf8Bytes(tool.name) +
          utf8Bytes(tool.description) +
          utf8Bytes(stableJsonStringify(tool.inputSchema)),
        0
      ),
    },
    history,
    ...(images > 0 ? { images } : {}),
    ...(input.contextDirectory === undefined ? {} : { contextDirectory: input.contextDirectory }),
  }
}

/**
 * Split a request's tokens by part. The total is what the meter counts; the split is an estimate:
 * each part's bytes at the request's bytes per token, each image at what a provider charges at
 * most for one, then scaled so the parts add up to the total exactly.
 */
export function apportionAgentContextTokens(input: {
  readonly totalTokens: number
  readonly bytes: AgentContextPartBytes<AgentContextPartName>
  readonly images?: number
  readonly bytesPerToken: number
}): readonly { readonly part: AgentContextPartName; readonly tokens: number }[] {
  const weights = AGENT_CONTEXT_PARTS.map((part) => ({
    part,
    weight:
      (input.bytes[part] ?? 0) / input.bytesPerToken +
      (part === "files" ? (input.images ?? 0) * AGENT_IMAGE_INPUT_TOKENS : 0),
  })).filter(({ weight }) => weight > 0)
  const sum = weights.reduce((total, { weight }) => total + weight, 0)
  const total = Math.max(0, Math.round(input.totalTokens))
  if (sum === 0 || total === 0) return []

  // Largest remainder: each part rounded down, then the tokens left to the largest fractions.
  const shares = weights.map(({ part, weight }) => {
    const exact = (weight / sum) * total
    return { part, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) }
  })
  let left = total - shares.reduce((sum, share) => sum + share.tokens, 0)
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    if (left === 0) break
    share.tokens += 1
    left -= 1
  }

  return shares.filter((share) => share.tokens > 0).map(({ part, tokens }) => ({ part, tokens }))
}

/** What the model reads of a tool result, as measureModelRequest weighs it. */
function toolResultBytes(output: { readonly value: JsonValue }): number {
  return typeof output.value === "string"
    ? utf8Bytes(output.value)
    : utf8Bytes(stableJsonStringify(output.value))
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
