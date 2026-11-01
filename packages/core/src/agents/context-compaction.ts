import { stableJsonStringify } from "../json"
import type { AgentMessageRecord } from "../storage/agents/types"
import { AGENT_CONTINUATION_INSTRUCTION, agentMessageSteps } from "./adapters"
import { agentMailInstruction } from "./agent-mail"
import { approvalOutcomeInstruction } from "./approval-outcome"
import { AGENT_IMAGE_INPUT_TOKENS, AGENT_INLINE_IMAGE_LIMITS } from "./inline-images"
import type { AgentMessage, AgentMessagePart } from "./message"
import { isAgentToolResult } from "./tool-result"

export const AGENT_CONTEXT_ESTIMATOR_VERSION = 1 as const

const CHARS_PER_TOKEN = 4
const REQUEST_OVERHEAD_TOKENS = 8
const MESSAGE_OVERHEAD_TOKENS = 8
const TOOL_OVERHEAD_TOKENS = 16
const STEP_OVERHEAD_TOKENS = 2
const FILE_TEXT_INLINE_MAX_BYTES = 50 * 1024
const FILE_TEXT_INLINE_TOTAL_MAX_BYTES = 200 * 1024
const TOOL_RESULT_SUMMARY_MAX_CHARS = 2_000

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

/** Estimate the provider request shape with one stable, conservative character heuristic. */
export function estimateAgentContextRequestTokens(
  input: EstimateAgentContextRequestTokensInput
): AgentContextTokenEstimate {
  const toolTokens = input.tools.reduce(
    (total, tool) =>
      total +
      TOOL_OVERHEAD_TOKENS +
      textTokens(tool.name) +
      textTokens(tool.description) +
      textTokens(tool.inputSchema),
    0
  )
  return {
    tokens:
      REQUEST_OVERHEAD_TOKENS +
      textTokens(input.systemPrompt) +
      toolTokens +
      estimateAgentContextMessagesTokens(input.messages).tokens,
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
  messages: readonly AgentMessage[]
): AgentContextTokenEstimate {
  const images = { remaining: AGENT_INLINE_IMAGE_LIMITS.maxImages }
  let tokens = 0
  for (const message of messages) {
    tokens += estimateMessageTokens(
      message,
      {
        textBytesRemaining: FILE_TEXT_INLINE_TOTAL_MAX_BYTES,
      },
      images
    )
    if (message.role === "assistant") tokens += toolImageTokens(message, images)
  }
  return { tokens, estimatorVersion: AGENT_CONTEXT_ESTIMATOR_VERSION }
}

/** Select the safe user boundary whose retained tail is closest to the configured recent budget. */
export function selectAgentContextCompactionBoundary(input: {
  readonly messages: readonly AgentMessageRecord[]
  readonly keepRecentTokens: number
}): AgentContextCompactionBoundary | null {
  if (input.messages.length < 2) return null

  let retainedTokens = 0
  let boundaryIndex: number | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = input.messages.length - 1; index > 0; index -= 1) {
    retainedTokens += estimateAgentContextMessagesTokens([input.messages[index]!]).tokens
    if (input.messages[index]?.role !== "user") continue

    const distance = Math.abs(input.keepRecentTokens - retainedTokens)
    if (distance <= closestDistance) {
      boundaryIndex = index
      closestDistance = distance
    }
    if (retainedTokens >= input.keepRecentTokens) break
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

/** Serialize durable conversation content as escaped quoted data for the summary model. */
export function serializeAgentMessagesForSummary(messages: readonly AgentMessageRecord[]): string {
  const lines = ["<sixb_conversation_history>"]
  for (const message of messages) {
    lines.push(
      `  <message id="${escapeXml(message.id)}" seq="${message.seq}" role="${message.role}">`
    )
    message.parts.forEach((part, partIndex) => {
      lines.push(...serializeSummaryPart(message, part, partIndex))
    })
    lines.push("  </message>")
  }
  lines.push("</sixb_conversation_history>")
  return lines.join("\n")
}

function estimateMessageTokens(
  message: AgentMessage,
  attachments: { textBytesRemaining: number },
  images: { remaining: number }
): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
      case "reasoning":
        tokens += textTokens(part.text)
        break
      case "step-start":
        tokens += STEP_OVERHEAD_TOKENS
        break
      case "continuation":
        tokens += textTokens(AGENT_CONTINUATION_INSTRUCTION)
        break
      case "approval-outcome":
        tokens += textTokens(approvalOutcomeInstruction(part))
        break
      case "mail":
        tokens += textTokens(agentMailInstruction(part))
        break
      case "context":
        tokens += textTokens(stableJsonStringify(part.context))
        break
      case "provider-state":
        tokens += textTokens(stableJsonStringify(part.data))
        break
      case "tool-call":
        tokens +=
          TOOL_OVERHEAD_TOKENS +
          textTokens(part.toolName) +
          textTokens(stableJsonStringify(part.input)) +
          toolOutputTokens(part)
        break
      case "file": {
        const file = part.fileRef
        tokens += textTokens(
          [file.blobId, file.digest, file.fileName, file.mediaType, file.logicalPath]
            .filter((value): value is string => value !== undefined)
            .join(" ")
        )
        if (message.role !== "assistant") {
          if (looksLikeImage(file.mediaType, file.fileName)) {
            tokens += imageTokens(images)
          } else {
            const inlineBytes = Math.min(
              file.sizeBytes,
              FILE_TEXT_INLINE_MAX_BYTES,
              attachments.textBytesRemaining
            )
            attachments.textBytesRemaining -= inlineBytes
            tokens += Math.ceil(inlineBytes / CHARS_PER_TOKEN)
          }
        }
        break
      }
    }
  }
  return tokens
}

function serializeSummaryPart(
  message: AgentMessageRecord,
  part: AgentMessagePart,
  partIndex: number
): string[] {
  const indent = "    "
  switch (part.type) {
    case "text":
      return [`${indent}<text>${escapeXml(part.text)}</text>`]
    case "reasoning":
    case "provider-state":
    case "step-start":
      return []
    case "continuation":
      return [`${indent}<continuation_request />`]
    case "approval-outcome":
      return [`${indent}${escapeXml(approvalOutcomeInstruction(part))}`]
    case "mail":
      return [`${indent}${escapeXml(agentMailInstruction(part))}`]
    case "context":
      return part.context.kind === "object"
        ? [
            `${indent}<object_context origin="${part.origin}" object_type_id="${escapeXml(part.context.ref.objectTypeId)}" primary_id="${escapeXml(part.context.ref.primaryId)}" />`,
          ]
        : [
            `${indent}<app_context origin="${part.origin}" id="${escapeXml(part.context.id)}" label="${escapeXml(part.context.label)}">`,
            `${indent}  <description>${escapeXml(part.context.description)}</description>`,
            `${indent}  <value format="json">${escapeXml(stableJsonStringify(part.context.value))}</value>`,
            `${indent}</app_context>`,
          ]
    case "file": {
      const file = part.fileRef
      const attributes = [
        `message_id="${escapeXml(message.id)}"`,
        `part_index="${partIndex}"`,
        `blob_id="${escapeXml(file.blobId)}"`,
        `digest="${escapeXml(file.digest)}"`,
        `size_bytes="${file.sizeBytes}"`,
        ...(file.fileName === undefined ? [] : [`file_name="${escapeXml(file.fileName)}"`]),
        ...(file.mediaType === undefined ? [] : [`media_type="${escapeXml(file.mediaType)}"`]),
        ...(file.logicalPath === undefined
          ? []
          : [`logical_path="${escapeXml(file.logicalPath)}"`]),
      ]
      return [`${indent}<file ${attributes.join(" ")} />`]
    }
    case "tool-call": {
      const output =
        part.state === "output-available"
          ? truncateToolResult(stableJsonStringify(part.output))
          : truncateToolResult(part.errorText)
      return [
        `${indent}<tool_call id="${escapeXml(part.toolCallId)}" name="${escapeXml(part.toolName)}" state="${part.state}">`,
        `${indent}  <input format="json">${escapeXml(stableJsonStringify(part.input))}</input>`,
        `${indent}  <result>${escapeXml(output)}</result>`,
        `${indent}</tool_call>`,
      ]
    }
  }
}

function truncateToolResult(value: string): string {
  if (value.length <= TOOL_RESULT_SUMMARY_MAX_CHARS) return value
  return `${value.slice(0, TOOL_RESULT_SUMMARY_MAX_CHARS)}\n[truncated ${value.length - TOOL_RESULT_SUMMARY_MAX_CHARS} characters]`
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
function toolOutputTokens(part: Extract<AgentMessagePart, { readonly type: "tool-call" }>): number {
  if (part.state === "output-error") return textTokens(part.errorText)
  if (part.modelOutput?.type === "text") return textTokens(part.modelOutput.value)
  if (part.modelOutput) return textTokens(stableJsonStringify(part.modelOutput.value))
  return textTokens(stableJsonStringify(part.output))
}

function textTokens(value: string): number {
  return Math.ceil(new TextEncoder().encode(value).byteLength / CHARS_PER_TOKEN)
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
