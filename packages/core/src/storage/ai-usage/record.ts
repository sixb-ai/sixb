import { normalizeRequesterGroupIds } from "../../auth/attribution"
import { isValidFileRef } from "../../blob-storage/validation"
import { assertJsonValue, isPlainRecord } from "../../json"
import { MODEL_KINDS } from "../../models/definitions"
import { normalizeModelProviderIds } from "../../models/events"
import { isModelReasoning } from "../../models/language-model"
import { AiUsageStorageError } from "./errors"
import type {
  AiModelCallFilesRecord,
  AiModelCallOperationRecord,
  AiModelCallUsageRecord,
  CreateAiModelCallOperationInput,
  RecordAiModelCallFilesInput,
  RecordAiModelCallInput,
  RecordAiModelCallOperationResultInput,
  SettleAiModelCallOperationInput,
  StartAiModelCallOperationInput,
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

/** Validate and defensively snapshot a call about to start, before the provider has it. */
export function normalizeAiModelCallOperation(
  input: CreateAiModelCallOperationInput
): AiModelCallOperationRecord {
  assertNonBlank(input.projectId, "projectId")
  assertNonBlank(input.callId, "callId")
  assertAiUsageExecutionId(input.executionId)
  assertPositiveSafeInteger(input.attempt, "attempt")
  if (!MODEL_KINDS.includes(input.modelKind)) {
    throw new TypeError("[Sixb] AI model kind is invalid.")
  }
  assertNonBlank(input.providerId, "providerId")
  assertNonBlank(input.modelId, "modelId")

  assertOperationRequest(input.request)
  if (typeof input.reserved !== "boolean") {
    throw new TypeError("[Sixb] AI model-call operation reserved must be a boolean.")
  }

  return {
    projectId: input.projectId,
    callId: input.callId,
    executionId: input.executionId,
    attempt: input.attempt,
    modelKind: input.modelKind,
    providerId: input.providerId,
    modelId: input.modelId,
    request: structuredClone(input.request),
    reserved: input.reserved,
    status: "pending",
    createdAt: cloneValidDate(input.createdAt ?? new Date(), "createdAt"),
  }
}

/** Validate the handle of a call the provider accepted. */
export function normalizeAiModelCallStart(
  input: StartAiModelCallOperationInput
): StartAiModelCallOperationInput {
  assertNonBlank(input.projectId, "projectId")
  assertNonBlank(input.callId, "callId")
  if (input.operation === null || input.operation === undefined) {
    throw new TypeError("[Sixb] AI model-call operation handle is required.")
  }
  assertJsonValue(input.operation, "AI model-call operation")
  assertOperationRequest(input.request)

  return {
    projectId: input.projectId,
    callId: input.callId,
    operation: structuredClone(input.operation),
    request: structuredClone(input.request),
  }
}

/** Validate what a pending call reported once it is in the ledger. */
export function normalizeAiModelCallOperationResult(
  input: RecordAiModelCallOperationResultInput
): RecordAiModelCallOperationResultInput {
  assertNonBlank(input.projectId, "projectId")
  assertNonBlank(input.callId, "callId")
  assertOperationResult(input.result)

  return { projectId: input.projectId, callId: input.callId, result: structuredClone(input.result) }
}

function assertOperationResult(result: unknown): void {
  if (!isPlainRecord(result)) {
    throw new TypeError("[Sixb] AI model-call operation result must be a JSON object.")
  }
  assertJsonValue(result, "AI model-call operation result")
}

function assertOperationRequest(request: unknown): void {
  if (!isPlainRecord(request)) {
    throw new TypeError("[Sixb] AI model-call operation request must be a JSON object.")
  }
  assertJsonValue(request, "AI model-call operation request")
}

/** Validate how a running call ended. */
export function normalizeAiModelCallSettlement(
  input: SettleAiModelCallOperationInput
): Required<Omit<SettleAiModelCallOperationInput, "error">> & { readonly error?: string } {
  assertNonBlank(input.projectId, "projectId")
  assertNonBlank(input.callId, "callId")
  if (input.status !== "completed" && input.status !== "failed") {
    throw new TypeError("[Sixb] AI model-call operation status must be 'completed' or 'failed'.")
  }
  if (input.error !== undefined) assertNonBlank(input.error, "operation error")
  assertOperationResult(input.result)

  return {
    projectId: input.projectId,
    callId: input.callId,
    status: input.status,
    ...(input.error === undefined ? {} : { error: input.error }),
    result: structuredClone(input.result),
    settledAt: cloneValidDate(input.settledAt ?? new Date(), "settledAt"),
  }
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
