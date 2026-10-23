import { normalizeRequesterGroupIds } from "../../auth/attribution"
import { isValidFileRef } from "../../blob-storage/validation"
import { assertJsonValue, isPlainRecord } from "../../json"
import { MODEL_KINDS } from "../../models/definitions"
import { normalizeModelProviderIds } from "../../models/events"
import { isModelReasoning } from "../../models/language-model"
import { AiUsageStorageError } from "./errors"
import type {
  AiModelCallFilesRecord,
  AiModelCallUsageRecord,
  RecordAiModelCallFilesInput,
  RecordAiModelCallInput,
} from "./types"
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

  if (input.modelKind !== undefined && !MODEL_KINDS.includes(input.modelKind)) {
    throw new TypeError("[Sixb] AI model kind is invalid.")
  }
  const occurredAt = cloneValidDate(input.occurredAt, "occurredAt")
  const recordedAt = cloneValidDate(input.recordedAt ?? new Date(), "recordedAt")
  const requesterGroupIds = normalizeRequesterGroupIds(input.requesterGroupIds)
  const requestedReasoning = cloneRequestedReasoning(input.requestedReasoning)
  const rawUsage = cloneRawUsage(input.rawUsage)

  return {
    id: input.id,
    projectId: input.projectId,
    executionId: input.executionId,
    attempt: input.attempt,
    callId: input.callId,
    requesterGroupIds,
    providerId: input.providerId,
    ...(input.providerIds === undefined
      ? {}
      : { providerIds: normalizeModelProviderIds(input.providerIds) }),
    requestedModelId: input.requestedModelId,
    ...(input.modelKind === undefined ? {} : { modelKind: input.modelKind }),
    ...(requestedReasoning === undefined ? {} : { requestedReasoning }),
    ...(input.responseModelId === undefined ? {} : { responseModelId: input.responseModelId }),
    responseId: input.responseId,
    usage: normalizeAiModelCallUsage(input.usage),
    ...(rawUsage === undefined ? {} : { rawUsage }),
    occurredAt,
    recordedAt,
  }
}

/** Validate and defensively snapshot the files one model call produced. */
export function normalizeAiModelCallFilesRecord(
  input: RecordAiModelCallFilesInput
): AiModelCallFilesRecord {
  assertNonBlank(input.projectId, "projectId")
  assertAiUsageExecutionId(input.executionId)
  assertNonBlank(input.callId, "callId")
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new TypeError("[Sixb] AI model-call files must be a nonempty array.")
  }
  if (!input.files.every(isValidFileRef)) {
    throw new TypeError("[Sixb] AI model-call files must be valid FileRefs.")
  }
  return {
    projectId: input.projectId,
    executionId: input.executionId,
    callId: input.callId,
    files: structuredClone(input.files),
    recordedAt: cloneValidDate(input.recordedAt ?? new Date(), "recordedAt"),
  }
}

/** A call's files belong to the execution that first recorded them. */
export function assertSameCallExecution(
  existing: AiModelCallFilesRecord,
  input: Pick<AiModelCallFilesRecord, "executionId" | "callId">
): AiModelCallFilesRecord {
  if (existing.executionId === input.executionId) return existing
  throw new AiUsageStorageError(
    "duplicate_id",
    `[Sixb] AI model call '${input.callId}' already has files from another execution.`
  )
}

function cloneRequestedReasoning(
  reasoning: RecordAiModelCallInput["requestedReasoning"]
): RecordAiModelCallInput["requestedReasoning"] {
  if (reasoning === undefined) return undefined
  if (!isModelReasoning(reasoning)) {
    throw new TypeError("[Sixb] AI usage requestedReasoning is invalid.")
  }
  return typeof reasoning === "string" ? reasoning : { budgetTokens: reasoning.budgetTokens }
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
