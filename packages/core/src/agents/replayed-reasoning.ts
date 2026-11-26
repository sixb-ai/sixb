import { isJsonObject, type JsonValue, stableJsonStringify } from "../json"
import type { ModelAssistantPart, ModelMessage } from "../models"

// A model's reasoning, replayed, is billed as the reasoning tokens its step was billed, however
// it is stored. Measured through the gateway, the same request with and without a step's items:
// GPT-6.2 Sol's 3,613 reasoning tokens, in 8 items of 55 KB, read as 3,615 more input tokens, in
// the same turn and the next; Gemini 4 Argon's 10,535, in one item of 42.5 KB, as 10,535 more.
// Its bytes say nothing of it: an OpenAI item runs from 3 KB for a few dozen tokens to 15 bytes a
// token, a Gemini one at 4.

/** Whether provider state is a model's reasoning item, as the Responses protocol replays it. */
export function isReplayedReasoning(data: JsonValue): boolean {
  const item = isJsonObject(data) ? data.item : undefined
  return isJsonObject(item) && item.type === "reasoning"
}

/**
 * Whether a request carries reasoning another model wrote, as after a switch of model or a step a
 * fallback answered. A reasoning item replays only to the model that wrote it, so this one never
 * reads it, though the estimate counts it.
 */
export function carriesOtherModelsReasoning(
  messages: readonly ModelMessage[],
  model: { readonly providerId: string; readonly modelId: string }
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => {
        if (part.type !== "provider-state" || !isReplayedReasoning(part.data)) return false

        const writer = isJsonObject(part.data) ? part.data.modelId : undefined
        return (
          part.providerId !== model.providerId ||
          (typeof writer === "string" && writer !== "" && writer !== model.modelId)
        )
      })
  )
}

/**
 * A response's parts, each reasoning item carrying its share of the reasoning tokens the step was
 * billed, split by its bytes so the shares add up to the total exactly. Without that count, or
 * without such an item, the parts as they are.
 */
export function withBilledReasoning(
  content: readonly ModelAssistantPart[],
  reasoningTokens: number | undefined
): readonly ModelAssistantPart[] {
  if (reasoningTokens === undefined) return content

  const items = content.flatMap((part, index) =>
    part.type === "provider-state" && isReplayedReasoning(part.data)
      ? [{ index, bytes: utf8Bytes(stableJsonStringify(part.data)) }]
      : []
  )
  if (items.length === 0) return content

  // Largest remainder: each share rounded down, then the tokens left to the largest fractions.
  const bytes = items.reduce((total, item) => total + item.bytes, 0)
  const shares = items.map((item) => {
    const exact =
      bytes > 0 ? (reasoningTokens * item.bytes) / bytes : reasoningTokens / items.length
    return { index: item.index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) }
  })
  let left = reasoningTokens - shares.reduce((total, share) => total + share.tokens, 0)
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    if (left <= 0) break
    share.tokens += 1
    left -= 1
  }

  const tokensAt = new Map(shares.map((share) => [share.index, share.tokens]))
  return content.map((part, index) => {
    const tokens = tokensAt.get(index)
    return tokens === undefined || part.type !== "provider-state" ? part : { ...part, tokens }
  })
}

/**
 * What replayed provider state weighs: the tokens its provider bills for it, when its response
 * said; else its JSON, read as text, the most it can weigh. Any other state, as a provider tool's
 * result, is content the model reads.
 */
export function providerStateSize(part: { readonly data: JsonValue; readonly tokens?: number }): {
  readonly bytes: number
  readonly tokens: number
} {
  return part.tokens === undefined
    ? { bytes: utf8Bytes(stableJsonStringify(part.data)), tokens: 0 }
    : { bytes: 0, tokens: part.tokens }
}

/**
 * Whether a message's reasoning text counts. Not beside a billed reasoning item: the provider
 * reads the item, whose count holds the reasoning whole, and never the text, which is its
 * summary or its readable copy.
 */
export function countsReasoningText(
  parts: readonly { readonly type: string; readonly tokens?: number }[]
): boolean {
  return !parts.some((part) => part.type === "provider-state" && part.tokens !== undefined)
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
