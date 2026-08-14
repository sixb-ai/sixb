import { assertJsonValue, compareStrings, isPlainRecord } from "../../json"
import type {
  AiModelCallUsageRecord,
  AiUsageExecutionIdentity,
  RecordAiModelCallInput,
} from "./types"
import { normalizeAiModelCallUsage } from "./usage"

/** Validate and defensively snapshot one provider-neutral model-call ledger input. */
export function normalizeAiModelCallRecord(input: RecordAiModelCallInput): AiModelCallUsageRecord {
  assertNonBlank(input.id, "id")
  assertNonBlank(input.projectId, "projectId")
  assertAiUsageExecution(input.execution)
  assertPositiveSafeInteger(input.attempt, "attempt")
  assertNonBlank(input.callId, "callId")
  assertPrincipal(input.requesterPrincipal)
  assertNonBlank(input.providerId, "providerId")
  assertNonBlank(input.requestedModelId, "requestedModelId")
  if (input.responseModelId !== undefined) {
    assertNonBlank(input.responseModelId, "responseModelId")
  }
  assertNonBlank(input.responseId, "responseId")

  const occurredAt = cloneValidDate(input.occurredAt, "occurredAt")
  const recordedAt = cloneValidDate(input.recordedAt ?? new Date(), "recordedAt")
  const requesterGroupIds = normalizeGroupIds(input.requesterGroupIds)
  const rawUsage = cloneRawUsage(input.rawUsage)

  return {
    id: input.id,
    projectId: input.projectId,
    execution: structuredClone(input.execution),
    attempt: input.attempt,
    callId: input.callId,
    requesterPrincipal: structuredClone(input.requesterPrincipal),
    requesterGroupIds,
    providerId: input.providerId,
    requestedModelId: input.requestedModelId,
    ...(input.responseModelId === undefined ? {} : { responseModelId: input.responseModelId }),
    responseId: input.responseId,
    usage: normalizeAiModelCallUsage(input.usage),
    ...(rawUsage === undefined ? {} : { rawUsage }),
    occurredAt,
    recordedAt,
  }
}

/** Validate a durable execution identity at storage and query boundaries. */
export function assertAiUsageExecution(execution: AiUsageExecutionIdentity): void {
  if (execution.kind === "agentRun") {
    assertNonBlank(execution.runId, "execution.runId")
    return
  }
  if (execution.kind === "workflowAgentNode") {
    assertNonBlank(execution.workflowRunId, "execution.workflowRunId")
    assertNonBlank(execution.nodeRunId, "execution.nodeRunId")
    return
  }
  throw new TypeError("[Sixb] AI usage execution kind is invalid.")
}

function normalizeGroupIds(groupIds: readonly string[]): readonly string[] {
  const unique = new Set<string>()
  for (const groupId of groupIds) {
    assertNonBlank(groupId, "requesterGroupIds[]")
    unique.add(groupId)
  }
  return [...unique].sort(compareStrings)
}

function cloneRawUsage(rawUsage: RecordAiModelCallInput["rawUsage"]) {
  if (rawUsage === undefined) return undefined
  if (!isPlainRecord(rawUsage)) {
    throw new TypeError("[Sixb] AI usage rawUsage must be a JSON object.")
  }
  assertJsonValue(rawUsage, "AI usage rawUsage")
  return structuredClone(rawUsage)
}

function assertPrincipal(principal: RecordAiModelCallInput["requesterPrincipal"]): void {
  if (
    principal.type !== "user" &&
    principal.type !== "serviceAccount" &&
    principal.type !== "system"
  ) {
    throw new TypeError("[Sixb] AI usage requesterPrincipal.type is invalid.")
  }
  assertNonBlank(principal.id, "requesterPrincipal.id")
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
