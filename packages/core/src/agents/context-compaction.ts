import { stableJsonStringify } from "../json"
import type { AgentMessageRecord } from "../storage/agents/types"
import type { AgentMessage, AgentMessagePart } from "./message"

export const AGENT_CONTEXT_ESTIMATOR_VERSION = 1 as const

const CHARS_PER_TOKEN = 4
const REQUEST_OVERHEAD_TOKENS = 8
const MESSAGE_OVERHEAD_TOKENS = 8
const TOOL_OVERHEAD_TOKENS = 16
const STEP_OVERHEAD_TOKENS = 2
const IMAGE_ALLOWANCE_TOKENS = 1_200
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
  readonly windowTokens: number
  readonly reserveTokens: number
}): boolean {
  return input.estimatedInputTokens > input.windowTokens - input.reserveTokens
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

/** Estimate message-only growth after a provider-usage anchor. */
export function estimateAgentContextMessagesTokens(
  messages: readonly AgentMessage[]
): AgentContextTokenEstimate {
  const attachments = { textBytesRemaining: FILE_TEXT_INLINE_TOTAL_MAX_BYTES }
  let tokens = 0
  for (const message of messages) {
    tokens += estimateMessageTokens(message, attachments)
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
  attachments: { textBytesRemaining: number }
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
      case "context":
        tokens += textTokens(stableJsonStringify(part.context))
        break
      case "tool-call":
        tokens +=
          TOOL_OVERHEAD_TOKENS +
          textTokens(part.toolName) +
          textTokens(stableJsonStringify(part.input)) +
          (part.state === "output-available"
            ? textTokens(stableJsonStringify(part.output))
            : textTokens(part.errorText))
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
            tokens += IMAGE_ALLOWANCE_TOKENS
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
    case "step-start":
      return []
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
