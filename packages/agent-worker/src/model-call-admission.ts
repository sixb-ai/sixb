import type { AiModelCallReservationIdentity, AiPricingContext } from "@sixb/core/storage"

/** Fixed internal allowance used only to estimate aggregate-budget reservations. */
export const AI_MODEL_CALL_OUTPUT_TOKEN_ALLOWANCE = 4_096

export type AiModelCallInputTokenEstimate =
  | {
      readonly status: "estimated"
      readonly tokens: number
      readonly method: "utf8BytesDividedByFour"
    }
  | {
      readonly status: "unavailable"
      readonly reason: "nonTextInput" | "unserializableInput"
    }

/** Provider-neutral snapshot passed to aggregate-budget admission before a provider request. */
export interface AiModelCallAdmissionInput {
  readonly projectId: string
  readonly executionId: string
  readonly attempt: number
  readonly requesterGroupIds: readonly string[]
  readonly callId: string
  readonly providerId: string
  readonly modelId: string
  readonly pricingContext: AiPricingContext
  readonly inputTokens: AiModelCallInputTokenEstimate
  readonly outputTokenAllowance: number
  readonly estimatedTotalTokens?: number
}

export interface AiModelCallAdmissionDecision {
  /** Active means accounting must reconcile the reservation for this provider attempt. */
  readonly reservation: "active" | "none"
}

export type BeforeAiModelCall = (
  input: AiModelCallAdmissionInput
) => AiModelCallAdmissionDecision | Promise<AiModelCallAdmissionDecision>

export type MarkAiModelCallUnknown = (input: AiModelCallReservationIdentity) => void | Promise<void>

/**
 * Estimate the exact, prepared provider request without requiring a provider-specific tokenizer.
 *
 * The heuristic is intentionally explicit so reservations are reproducible. Non-text inputs are
 * reported as unavailable; an enforced token or cost policy can then fail closed instead of
 * pretending that an image, file, or provider-defined payload has no token cost.
 */
export function estimateAiModelCallInputTokens(input: {
  readonly prompt: unknown
  readonly tools: unknown
  readonly responseFormat: unknown
}): AiModelCallInputTokenEstimate {
  if (containsNonTextInput(input.prompt)) {
    return { status: "unavailable", reason: "nonTextInput" }
  }

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input)
  } catch {
    return { status: "unavailable", reason: "unserializableInput" }
  }
  if (serialized === undefined) {
    return { status: "unavailable", reason: "unserializableInput" }
  }

  const bytes = new TextEncoder().encode(serialized).byteLength
  return {
    status: "estimated",
    tokens: Math.ceil(bytes / 4),
    method: "utf8BytesDividedByFour",
  }
}

export function aiModelCallOutputTokenAllowance(maxOutputTokens: number | undefined): number {
  if (maxOutputTokens === undefined) return AI_MODEL_CALL_OUTPUT_TOKEN_ALLOWANCE
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError(
      "[SixbAgentWorker] AI model-call maxOutputTokens must be a positive safe integer."
    )
  }
  return maxOutputTokens
}

export function estimatedAiModelCallTotalTokens(
  inputTokens: AiModelCallInputTokenEstimate,
  outputTokenAllowance: number
): number | undefined {
  if (inputTokens.status !== "estimated") return undefined
  const total = inputTokens.tokens + outputTokenAllowance
  if (!Number.isSafeInteger(total)) {
    throw new TypeError("[SixbAgentWorker] AI model-call token estimate exceeds the safe range.")
  }
  return total
}

function containsNonTextInput(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") return false
  if (
    value instanceof URL ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  ) {
    return true
  }
  if (seen.has(value)) return false
  seen.add(value)

  if (!Array.isArray(value)) {
    const type = Reflect.get(value, "type")
    if (type === "image" || type === "file" || type === "reasoning-file" || type === "custom") {
      return true
    }
  }

  return Object.values(value).some((entry) => containsNonTextInput(entry, seen))
}
