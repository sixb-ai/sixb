import type { AiModelCallUsage, AiModelCallUsageInput } from "./types"

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "uncachedInputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "textOutputTokens",
  "reasoningOutputTokens",
] as const

type AiUsageField = (typeof USAGE_FIELDS)[number]

/** Validate provider-neutral counts and derive total/reporting fields without inventing zeroes. */
export function normalizeAiModelCallUsage(input: AiModelCallUsageInput): AiModelCallUsage {
  for (const field of USAGE_FIELDS) {
    assertUsageCount(input[field], field)
  }

  const totalTokens =
    input.inputTokens === undefined || input.outputTokens === undefined
      ? undefined
      : addUsageCounts(input.inputTokens, input.outputTokens, "totalTokens")
  const reportingStatus =
    input.inputTokens !== undefined && input.outputTokens !== undefined
      ? "complete"
      : USAGE_FIELDS.some((field) => input[field] !== undefined)
        ? "partial"
        : "unavailable"

  return {
    ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(input.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: input.uncachedInputTokens }),
    ...(input.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: input.cacheReadInputTokens }),
    ...(input.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: input.cacheWriteInputTokens }),
    ...(input.textOutputTokens === undefined ? {} : { textOutputTokens: input.textOutputTokens }),
    ...(input.reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens: input.reasoningOutputTokens }),
    reportingStatus,
  }
}

/**
 * Aggregate model-call usage without treating a missing count as zero.
 *
 * A field is present only when every call reported it. This prevents a partial provider response
 * from becoming an apparently complete execution total. Zero remains a reported value.
 */
export function aggregateAiModelCallUsage(
  usages: Iterable<AiModelCallUsageInput>
): AiModelCallUsage {
  const normalized = Array.from(usages, normalizeAiModelCallUsage)
  const fields = Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, sumUsageField(normalized, field)])
  ) as Record<AiUsageField, number | undefined>
  const aggregate = normalizeAiModelCallUsage(fields)

  if (
    aggregate.reportingStatus === "unavailable" &&
    normalized.some((usage) => usage.reportingStatus !== "unavailable")
  ) {
    return { ...aggregate, reportingStatus: "partial" }
  }
  return aggregate
}

function sumUsageField(
  usages: readonly AiModelCallUsage[],
  field: AiUsageField
): number | undefined {
  if (usages.length === 0) return undefined

  let total = 0
  for (const usage of usages) {
    const value = usage[field]
    if (value === undefined) return undefined
    total = addUsageCounts(total, value, `aggregate ${field}`)
  }
  return total
}

function assertUsageCount(value: number | undefined, field: AiUsageField): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`[Sixb] AI model-call usage ${field} must be a non-negative safe integer.`)
  }
}

function addUsageCounts(left: number, right: number, field: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`[Sixb] AI model-call usage ${field} exceeds the safe integer range.`)
  }
  return result
}
