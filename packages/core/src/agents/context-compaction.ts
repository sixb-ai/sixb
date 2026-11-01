import { stableJsonStringify } from "../json"
import type { ModelMessage, ModelResponseFormat, ModelToolSpecification } from "../models"
import type { AgentMessageRecord } from "../storage/agents/types"
import { AGENT_CONTINUATION_INSTRUCTION, agentMessageSteps } from "./adapters"
import { agentMailInstruction } from "./agent-mail"
import { approvalOutcomeInstruction } from "./approval-outcome"
import { AGENT_IMAGE_INPUT_TOKENS, AGENT_INLINE_IMAGE_LIMITS } from "./inline-images"
import type { AgentMessage, AgentMessagePart } from "./message"
import { isAgentToolResult } from "./tool-result"

/**
 * 2: text counts in UTF-8 bytes at the model's own bytes per token; retained attachments, the
 * images tools returned and stored model-facing tool output count as the model reads them.
 */
export const AGENT_CONTEXT_ESTIMATOR_VERSION = 2 as const

const REQUEST_OVERHEAD_TOKENS = 8
const MESSAGE_OVERHEAD_TOKENS = 8
const TOOL_OVERHEAD_TOKENS = 16
const STEP_OVERHEAD_TOKENS = 2
const FILE_TEXT_INLINE_MAX_BYTES = 50 * 1024
const FILE_TEXT_INLINE_TOTAL_MAX_BYTES = 200 * 1024

export interface AgentContextEstimateTool {
  readonly name: string
  readonly description: string
  /** Deterministic JSON-schema serialization sent for this tool. */
  readonly inputSchema: string
}

export interface EstimateAgentContextRequestTokensInput {
  readonly systemPrompt: string
  readonly tools: readonly AgentContextEstimateTool[]
  readonly messages: readonly AgentMessage[]
}

/**
 * What a request weighs before any tokenizer: the UTF-8 bytes of its text, and the tokens already
 * counted as such (per-item overheads, image allowances).
 */
export interface AgentContextSize {
  readonly bytes: number
  readonly tokens: number
  /** The images among `tokens`, each counted as the most a provider charges for one. */
  readonly images?: number
}

export interface AgentContextTokenEstimate {
  readonly tokens: number
  readonly estimatorVersion: typeof AGENT_CONTEXT_ESTIMATOR_VERSION
}

export interface AgentContextCompactionBoundary {
  readonly messagesToSummarize: readonly AgentMessageRecord[]
  readonly retainedMessages: readonly AgentMessageRecord[]
  readonly summarizedThroughSeq: number
}

/** Compaction begins only once the estimated request crosses the reserved input budget. */
export function shouldCompactAgentContext(input: {
  readonly estimatedInputTokens: number
  readonly inputBudgetTokens: number
}): boolean {
  return input.estimatedInputTokens > input.inputBudgetTokens
}

/** Estimate the provider request shape at the model's bytes-per-token rate. */
export function estimateAgentContextRequestTokens(
  input: EstimateAgentContextRequestTokensInput & { readonly bytesPerToken: number }
): AgentContextTokenEstimate {
  return {
    tokens: agentContextSizeTokens(measureAgentContextRequest(input), input.bytesPerToken),
    estimatorVersion: AGENT_CONTEXT_ESTIMATOR_VERSION,
  }
}

/**
 * Estimate message-only growth after a provider-usage anchor. Every user message the history keeps
 * sends its files inline, each message within its own text budget, until compaction summarizes it,
 * and so do the images its tools returned after each step.
 *
 * Images count up to the request's image limit. Its byte limit is left out: an image's encoded
 * size is known only once it is projected, and counting more images is the side that cannot
 * overflow.
 */
export function estimateAgentContextMessagesTokens(
  messages: readonly AgentMessage[],
  bytesPerToken: number
): AgentContextTokenEstimate {
  return {
    tokens: agentContextSizeTokens(measureAgentContextMessages(messages), bytesPerToken),
    estimatorVersion: AGENT_CONTEXT_ESTIMATOR_VERSION,
  }
}

/** Weigh a stored conversation request: its system prompt, tool catalog and messages. */
export function measureAgentContextRequest(
  input: EstimateAgentContextRequestTokensInput
): AgentContextSize {
  const size = { bytes: utf8Bytes(input.systemPrompt), tokens: REQUEST_OVERHEAD_TOKENS }
  for (const tool of input.tools) {
    size.tokens += TOOL_OVERHEAD_TOKENS
    size.bytes += utf8Bytes(tool.name) + utf8Bytes(tool.description) + utf8Bytes(tool.inputSchema)
  }

  const messages = measureAgentContextMessages(input.messages)
  return {
    bytes: size.bytes + messages.bytes,
    tokens: size.tokens + messages.tokens,
    images: messages.images ?? 0,
  }
}

function measureAgentContextMessages(messages: readonly AgentMessage[]): AgentContextSize {
  const images = { remaining: AGENT_INLINE_IMAGE_LIMITS.maxImages }
  const size = { bytes: 0, tokens: 0 }
  for (const message of messages) {
    measureMessage(message, { textBytesRemaining: FILE_TEXT_INLINE_TOTAL_MAX_BYTES }, images, size)
    if (message.role === "assistant") size.tokens += toolImageTokens(message, images)
  }
  return { ...size, images: AGENT_INLINE_IMAGE_LIMITS.maxImages - images.remaining }
}

/** Price a measured request at a tokenizer's rate. */
export function agentContextSizeTokens(size: AgentContextSize, bytesPerToken: number): number {
  return size.tokens + Math.ceil(size.bytes / bytesPerToken)
}

/**
 * What an agent's model call weighs before any tokenizer, as the conversation estimator weighs it:
 * what its output ceiling, its guard and its measurement of the tokenizer go by.
 *
 * An image counts as the most a provider charges for one, never as its base64 bytes. Attachments
 * stay in a thread's requests until compaction, so giving up on any file would cap every later
 * call of the thread at the reserve. Other inline files count by their encoded bytes.
 */
export function measureAgentModelRequest(request: {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolSpecification[]
  readonly responseFormat?: ModelResponseFormat
}): AgentContextSize {
  const size = { ...measureModelRequest(request), images: 0 }
  for (const message of request.messages) {
    if (message.role !== "user") continue

    for (const part of message.content) {
      if (part.type !== "file") continue

      if (part.mediaType.startsWith("image/")) {
        size.tokens += AGENT_IMAGE_INPUT_TOKENS
        size.images += 1
      } else {
        size.bytes += utf8Bytes(part.data.href)
      }
    }
  }
  return size
}

/**
 * Weigh one outgoing model request the same way as a stored conversation: the same parts, the
 * same overheads. A file part counts by its name and media type only; what an attached file costs
 * is the caller's call.
 */
export function measureModelRequest(request: {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolSpecification[]
  readonly responseFormat?: ModelResponseFormat
}): AgentContextSize {
  const size = { bytes: 0, tokens: REQUEST_OVERHEAD_TOKENS }
  for (const tool of request.tools) {
    size.tokens += TOOL_OVERHEAD_TOKENS
    size.bytes +=
      utf8Bytes(tool.name) +
      utf8Bytes(tool.description) +
      utf8Bytes(stableJsonStringify(tool.inputSchema))
  }
  if (request.responseFormat) {
    size.bytes += utf8Bytes(stableJsonStringify(request.responseFormat.schema))
  }

  for (const message of request.messages) {
    size.tokens += MESSAGE_OVERHEAD_TOKENS
    if (message.role === "system") {
      size.bytes += utf8Bytes(message.content)
      continue
    }
    for (const part of message.content) {
      switch (part.type) {
        case "text":
        case "reasoning":
          size.bytes += utf8Bytes(part.text)
          break
        case "file":
          size.bytes += utf8Bytes(`${part.filename ?? ""} ${part.mediaType}`)
          break
        case "provider-state":
          size.bytes += utf8Bytes(stableJsonStringify(part.data))
          break
        case "tool-call":
          size.tokens += TOOL_OVERHEAD_TOKENS
          size.bytes += utf8Bytes(part.toolName) + utf8Bytes(stableJsonStringify(part.input))
          break
        case "tool-result":
          size.tokens += TOOL_OVERHEAD_TOKENS
          size.bytes +=
            typeof part.output.value === "string"
              ? utf8Bytes(part.output.value)
              : utf8Bytes(stableJsonStringify(part.output.value))
          break
      }
    }
  }

  return size
}

/**
 * Select the user boundary that keeps the most recent work within `keepRecentTokens`: the oldest
 * user message whose turn, and everything after it, fit; else the newest one, whose turn is always
 * kept. The tail never grows past the allowance to land closer to it, so a compaction ends where
 * it aims and the next turn does not compact again.
 */
export function selectAgentContextCompactionBoundary(input: {
  readonly messages: readonly AgentMessageRecord[]
  readonly keepRecentTokens: number
  readonly bytesPerToken: number
}): AgentContextCompactionBoundary | null {
  if (input.messages.length < 2) return null

  let retainedTokens = 0
  let boundaryIndex: number | null = null
  for (let index = input.messages.length - 1; index > 0; index -= 1) {
    retainedTokens += estimateAgentContextMessagesTokens(
      [input.messages[index]!],
      input.bytesPerToken
    ).tokens
    if (input.messages[index]?.role !== "user") continue
    if (boundaryIndex !== null && retainedTokens > input.keepRecentTokens) break

    boundaryIndex = index
  }

  if (boundaryIndex === null) return null

  const summarizedThroughSeq = input.messages[boundaryIndex - 1]?.seq
  if (summarizedThroughSeq === undefined) return null
  return {
    messagesToSummarize: input.messages.slice(0, boundaryIndex),
    retainedMessages: input.messages.slice(boundaryIndex),
    summarizedThroughSeq,
  }
}

function measureMessage(
  message: AgentMessage,
  attachments: { textBytesRemaining: number },
  images: { remaining: number },
  size: { bytes: number; tokens: number }
): void {
  size.tokens += MESSAGE_OVERHEAD_TOKENS
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
      case "reasoning":
        size.bytes += utf8Bytes(part.text)
        break
      case "step-start":
        size.tokens += STEP_OVERHEAD_TOKENS
        break
      case "continuation":
        size.bytes += utf8Bytes(AGENT_CONTINUATION_INSTRUCTION)
        break
      case "approval-outcome":
        size.bytes += utf8Bytes(approvalOutcomeInstruction(part))
        break
      case "mail":
        size.bytes += utf8Bytes(agentMailInstruction(part))
        break
      case "context":
        size.bytes += utf8Bytes(stableJsonStringify(part.context))
        break
      case "provider-state":
        size.bytes += utf8Bytes(stableJsonStringify(part.data))
        break
      case "tool-call":
        size.tokens += TOOL_OVERHEAD_TOKENS
        size.bytes +=
          utf8Bytes(part.toolName) +
          utf8Bytes(stableJsonStringify(part.input)) +
          toolOutputBytes(part)
        break
      case "file": {
        const file = part.fileRef
        size.bytes += utf8Bytes(
          [file.blobId, file.digest, file.fileName, file.mediaType, file.logicalPath]
            .filter((value): value is string => value !== undefined)
            .join(" ")
        )
        if (message.role !== "assistant") {
          if (looksLikeImage(file.mediaType, file.fileName)) {
            size.tokens += imageTokens(images)
          } else {
            const inlineBytes = Math.min(
              file.sizeBytes,
              FILE_TEXT_INLINE_MAX_BYTES,
              attachments.textBytesRemaining
            )
            attachments.textBytesRemaining -= inlineBytes
            size.bytes += inlineBytes
          }
        }
        break
      }
    }
  }
}

function looksLikeImage(mediaType: string | undefined, fileName: string | undefined): boolean {
  if (mediaType?.toLowerCase().startsWith("image/")) return true
  return /\.(?:avif|gif|jpe?g|png|webp)$/i.test(fileName ?? "")
}

/**
 * The images each step's calls returned, once each, as the message after the step inlines them.
 * Every call counts, whether or not its tool's images reach the model: the side that cannot
 * overflow.
 */
function toolImageTokens(message: AgentMessage, images: { remaining: number }): number {
  let tokens = 0
  for (const step of agentMessageSteps(message)) {
    const seen = new Set<string>()
    for (const { part } of step.localToolCalls) {
      if (part.state !== "output-available" || !isAgentToolResult(part.output)) continue

      for (const content of part.output.content) {
        if (content.type !== "file") continue
        if (!looksLikeImage(content.fileRef.mediaType, content.fileRef.fileName)) continue

        const identity = `${content.fileRef.digest}:${content.fileRef.sizeBytes}`
        if (seen.has(identity)) continue
        seen.add(identity)
        tokens += imageTokens(images)
      }
    }
  }
  return tokens
}

/** One more inline image, while the request takes any. */
function imageTokens(images: { remaining: number }): number {
  if (images.remaining === 0) return 0

  images.remaining -= 1
  return AGENT_IMAGE_INPUT_TOKENS
}

/** What the model reads of a call's outcome: the output its tool projected, when it stored one. */
function toolOutputBytes(part: Extract<AgentMessagePart, { readonly type: "tool-call" }>): number {
  if (part.state === "output-error") return utf8Bytes(part.errorText)
  if (part.modelOutput?.type === "text") return utf8Bytes(part.modelOutput.value)
  if (part.modelOutput) return utf8Bytes(stableJsonStringify(part.modelOutput.value))
  return utf8Bytes(stableJsonStringify(part.output))
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
