import { normalizeRequesterGroupIds } from "../../auth/attribution"
import { assertJsonValue, isPlainRecord } from "../../json"
import type { AiModelCallUsageRecord, RecordAiModelCallInput } from "./types"
import { normalizeAiModelCallUsage } from "./usage"

/** Validate and defensively snapshot one provider-neutral model-call ledger input. */
export function normalizeAiModelCallRecord(input: RecordAiModelCallInput): AiModelCallUsageRecord {
  assertNonBlank(input.id, "id")
  assertNonBlank(input.projectId, "projectId")
  assertAiUsageExecutionId(input.executionId)
  assertPositiveSafeInteger(input.attempt, "attempt")
  assertNonBlank(input.callId, "callId")
  assertNonBlank(input.providerId, "providerId")
  assertNonBlank(input.requestedModelId, "requestedModelId")
  if (input.responseModelId !== undefined) {
    assertNonBlank(input.responseModelId, "responseModelId")
  }
  assertNonBlank(input.responseId, "responseId")

  const occurredAt = cloneValidDate(input.occurredAt, "occurredAt")
  const recordedAt = cloneValidDate(input.recordedAt ?? new Date(), "recordedAt")
  const requesterGroupIds = normalizeRequesterGroupIds(input.requesterGroupIds)
  const rawUsage = cloneRawUsage(input.rawUsage)
  const modelDefinition = cloneJsonMetadata(input.modelDefinition, "modelDefinition")
  const cost = cloneJsonMetadata(input.cost, "cost")
  const route = cloneJsonMetadata(input.route, "route")

  return {
    id: input.id,
    projectId: input.projectId,
    executionId: input.executionId,
    attempt: input.attempt,
    callId: input.callId,
    requesterGroupIds,
    providerId: input.providerId,
    requestedModelId: input.requestedModelId,
    ...(input.responseModelId === undefined ? {} : { responseModelId: input.responseModelId }),
    responseId: input.responseId,
    usage: normalizeAiModelCallUsage(input.usage),
    ...(modelDefinition === undefined ? {} : { modelDefinition }),
    ...(cost === undefined ? {} : { cost }),
    ...(route === undefined ? {} : { route }),
    ...(rawUsage === undefined ? {} : { rawUsage }),
    occurredAt,
    recordedAt,
  }
}

function cloneJsonMetadata<T>(value: T | undefined, field: string): T | undefined {
  if (value === undefined) return undefined
  assertJsonValue(value, `AI usage ${field}`)
  return structuredClone(value)
}

/** Validate a durable execution reference at storage and query boundaries. */
export function assertAiUsageExecutionId(executionId: string): void {
  assertNonBlank(executionId, "executionId")
}

function cloneRawUsage(rawUsage: RecordAiModelCallInput["rawUsage"]) {
  if (rawUsage === undefined) return undefined
  if (!isPlainRecord(rawUsage)) {
    throw new TypeError("[Sixb] AI usage rawUsage must be a JSON object.")
  }
  assertJsonValue(rawUsage, "AI usage rawUsage")
  return structuredClone(rawUsage)
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`[Sixb] AI usage ${field} must be nonblank.`)
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`[Sixb] AI usage ${field} must be a positive safe integer.`)
  }
}

function cloneValidDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`[Sixb] AI usage ${field} must be a valid Date.`)
  }
  return new Date(value)
}
