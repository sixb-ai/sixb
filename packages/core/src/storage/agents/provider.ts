import { isDeepStrictEqual } from "node:util"
import { AGENT_REASONING_LEVELS } from "../../agents/types"
import { isFileRef } from "../../blob-storage"
import { isJsonObject, isPlainRecord } from "../../json"
import { isModelReasoning } from "../../models/language-model"
import type { ExecutionRecord, ExecutionStorage } from "../executions"
import { findAgentRunExecution } from "../executions/run-link"
import { AgentStorageError } from "./errors"
import type {
  AgentContextCheckpointRecord,
  AgentMessageRecord,
  AgentRunRecord,
  AgentThreadRecord,
  AgentThreadSandbox,
  AgentWorkspaceState,
  ConversationAgentRunSpec,
  CreateAgentContextCheckpointInput,
  CreateSubagentRunInput,
  SubagentRunRecord,
  SubagentRunResult,
  TransitionAgentWorkspaceInput,
} from "./types"

/** Shared state machine. Providers must lock the run, then thread, around this decision/write. */
export function transitionAgentWorkspace(
  thread: AgentThreadRecord | null,
  run: AgentRunRecord | null,
  input: TransitionAgentWorkspaceInput
): AgentWorkspaceState {
  const fail = (message: string): never => {
    throw new AgentStorageError("invalid_state", `[Sixb] Workspace ${message}`)
  }
  if (!thread?.sandbox) return fail("is not configured on this thread.")
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.generation)) return fail("generation is invalid.")
  const state = thread.workspaceState
  if (input.action === "recreate") {
    if (thread.activeRunId !== null) return fail("cannot be recreated during an active run.")
    if (
      !state ||
      state.generation !== input.expectedGeneration ||
      input.generation === state.generation
    )
      return fail("changed; reload before recreating.")
    if (!["busy", "blocked", "unavailable"].includes(state.status)) {
      return fail("does not require recovery.")
    }
    return {
      generation: input.generation,
      status: "new",
      initialized: false,
      resetAt: new Date().toISOString(),
    }
  }
  if (
    run?.kind !== "conversation" ||
    run.threadId !== thread.id ||
    run.status !== "running" ||
    thread.activeRunId !== run.id ||
    run.id !== input.runId ||
    run.execution?.token !== input.executionToken ||
    run.execution.queueLeaseExpiresAt.getTime() <= Date.now()
  ) {
    throw new AgentStorageError("execution_lost", "[Sixb] Workspace execution ownership was lost.")
  }
  if (input.action === "acquire") {
    if (state && state.status !== "new" && state.status !== "ready") {
      return fail("requires recovery; previous operations may still be in flight.")
    }
    if (state && state.generation !== input.generation) return fail("generation changed.")
    if (!/^[a-f0-9]{64}$/.test(input.sourceFingerprint))
      return fail("source fingerprint is invalid.")
    if (state?.sourceFingerprint && state.sourceFingerprint !== input.sourceFingerprint) {
      return fail("source identity changed; the existing checkout was not opened.")
    }
    return {
      generation: input.generation,
      status: "busy",
      initialized: state?.initialized ?? false,
      ...(state?.resetAt ? { resetAt: state.resetAt } : {}),
      sourceFingerprint: input.sourceFingerprint,
      owner: { runId: input.runId, executionToken: input.executionToken },
    }
  }
  if (
    state?.status !== "busy" ||
    state.generation !== input.generation ||
    state.owner?.runId !== input.runId ||
    state.owner.executionToken !== input.executionToken
  ) {
    return fail("is not owned by this execution.")
  }
  if (input.action === "replace") {
    if (
      !state.initialized ||
      input.nextGeneration === state.generation ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(input.nextGeneration)
    ) {
      return fail("replacement requires initialized state and a fresh valid generation.")
    }
    // Only the owning worker may report confirmed loss; retain its fence across replacement.
    return {
      ...state,
      generation: input.nextGeneration,
      initialized: false,
      resetAt: new Date().toISOString(),
    }
  }
  if (input.status === "ready" && !input.initialized) return fail("initialization is incomplete.")
  return {
    generation: state.generation,
    status: input.status,
    initialized: input.initialized,
    sourceFingerprint: state.sourceFingerprint,
    ...(state.resetAt ? { resetAt: state.resetAt } : {}),
  }
}

/** Keep caller-controlled binding data separate from future worker-owned sandbox state. */
export function snapshotAgentThreadSandbox(value: unknown): AgentThreadSandbox {
  if (!isPlainRecord(value) || !isJsonObject(value)) {
    throw new AgentStorageError(
      "invalid_input",
      "[Sixb] Thread sandbox must contain only JSON params."
    )
  }
  return structuredClone(value)
}

/** Validate the provider-neutral model selection captured for a conversational turn. */
export function assertConversationAgentRunSpec(
  spec: ConversationAgentRunSpec,
  prefix = "Sixb"
): void {
  if (!isRecord(spec) || !isRecord(spec.model)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Conversational Agent run spec must contain a model reference.`
    )
  }
  for (const [name, value] of [
    ["model.provider", spec.model.provider],
    ["model.modelId", spec.model.modelId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Conversational Agent run '${name}' must not be empty.`
      )
    }
  }
  if (spec.reasoning !== undefined && !isModelReasoning(spec.reasoning)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Conversational Agent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}, or a nonnegative budgetTokens object.`
    )
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate the semantic link between a conversational Agent run and its immutable execution. */
export async function assertAgentRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
}): Promise<ExecutionRecord> {
  const execution = await findAgentRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    runId: input.runId,
    authority: { type: "inherited" },
  })
  if (!execution) {
    throw new AgentStorageError(
      "invalid_input",
      `[Sixb] Execution '${input.executionId}' does not authorize Agent run '${input.runId}'.`
    )
  }
  return execution
}

/** Validate the provider-neutral payload of an idempotent child admission. */
export function assertCreateSubagentRunInput(input: CreateSubagentRunInput, prefix = "Sixb"): void {
  for (const [name, value] of [
    ["id", input.id],
    ["projectId", input.projectId],
    ["executionId", input.executionId],
    ["parentRunId", input.parentRunId],
    ["parentExecutionToken", input.parentExecutionToken],
    ["spawnKey", input.spawnKey],
    ["model.provider", input.spec.model.provider],
    ["model.modelId", input.spec.model.modelId],
    ["task", input.spec.task],
  ] as const) {
    if (value.trim().length === 0) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Subagent run '${name}' must not be empty.`
      )
    }
  }
  if (input.spawnKey.length > 128) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent spawn key must not exceed 128 characters.`
    )
  }
  for (const [name, value] of [
    ["maxActiveChildren", input.maxActiveChildren],
    ["spec.maxSteps", input.spec.maxSteps],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Subagent run '${name}' must be a positive safe integer.`
      )
    }
  }
  if (new Set(input.spec.toolNames).size !== input.spec.toolNames.length) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run tool names must be unique.`
    )
  }
  if (input.spec.reasoning !== undefined && !isModelReasoning(input.spec.reasoning)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}, or a nonnegative budgetTokens object.`
    )
  }
  if (input.spec.toolNames.some((name) => !name.trim())) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run tool names must not be empty.`
    )
  }
  if (input.createdAt && !Number.isFinite(input.createdAt.getTime())) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run createdAt must be a valid date.`
    )
  }
}

/** Exact semantic match required when a durable spawn key is replayed. */
export function subagentRunMatchesCreateInput(
  run: AgentRunRecord,
  input: CreateSubagentRunInput
): run is SubagentRunRecord {
  return (
    run.kind === "subagent" &&
    run.id === input.id &&
    run.projectId === input.projectId &&
    run.executionId === input.executionId &&
    run.parentRunId === input.parentRunId &&
    run.spawnKey === input.spawnKey &&
    isDeepStrictEqual(run.spec, input.spec)
  )
}

/** Validate the small durable result returned by a successful child. */
export function assertSubagentRunResult(
  result: SubagentRunResult | undefined,
  runId: string,
  prefix = "Sixb"
): asserts result is SubagentRunResult {
  const text = result?.text
  const files = result?.files
  const hasText = typeof text === "string" && text.trim().length > 0
  const hasFiles = Array.isArray(files) && files.length > 0 && files.every(isFileRef)
  if (!result || (!hasText && !hasFiles)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Succeeded subagent run '${runId}' requires text or files.`
    )
  }
  if ((text !== undefined && !hasText) || (files !== undefined && !hasFiles)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run '${runId}' has an invalid result.`
    )
  }
}

/** Validate provider-independent checkpoint fields before entering a storage critical section. */
export function assertCreateAgentContextCheckpointInput(
  input: CreateAgentContextCheckpointInput,
  prefix = "Sixb"
): void {
  for (const [name, value] of [
    ["id", input.id],
    ["projectId", input.projectId],
    ["threadId", input.threadId],
    ["createdByRunId", input.createdByRunId],
    ["executionToken", input.executionToken],
    ["summary", input.summary],
    ["summaryModelId", input.summaryModelId],
  ] as const) {
    if (value.trim().length === 0) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Agent context checkpoint '${name}' must not be empty.`
      )
    }
  }

  if (input.summaryFormatVersion !== 1) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint summary format version must be 1.`
    )
  }
  if (input.reason !== "threshold" && input.reason !== "overflow") {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint reason must be 'threshold' or 'overflow'.`
    )
  }
  if (
    input.expectedPreviousCheckpointId !== null &&
    input.expectedPreviousCheckpointId.trim().length === 0
  ) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint expected previous id must not be empty.`
    )
  }
  if (input.createdAt && !Number.isFinite(input.createdAt.getTime())) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint createdAt must be a valid date.`
    )
  }

  for (const [name, value, minimum] of [
    ["expectedHeadSeq", input.expectedHeadSeq, 1],
    ["summarizedThroughSeq", input.summarizedThroughSeq, 1],
    ["observedHeadSeq", input.observedHeadSeq, 1],
    ["estimatedInputTokensBefore", input.estimatedInputTokensBefore, 0],
    ["estimatedInputTokensAfter", input.estimatedInputTokensAfter, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Agent context checkpoint '${name}' must be a safe integer greater than or equal to ${minimum}.`
      )
    }
  }

  if (input.observedHeadSeq !== input.expectedHeadSeq) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint observed head must equal its expected message head.`
    )
  }
  if (input.summarizedThroughSeq >= input.observedHeadSeq) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint must retain the triggering head message.`
    )
  }
}

/** Assert that the current delivery still owns the active conversational run. */
export function assertAgentContextCheckpointAuthority(input: {
  readonly create: CreateAgentContextCheckpointInput
  readonly run: AgentRunRecord | null
  readonly thread: AgentThreadRecord | null
  readonly prefix?: string
}): asserts input is typeof input & {
  readonly run: AgentRunRecord
  readonly thread: AgentThreadRecord
} {
  const { create, run, thread } = input
  const prefix = input.prefix ?? "Sixb"
  if (!run) {
    throw new AgentStorageError(
      "run_not_found",
      `[${prefix}] Agent run '${create.createdByRunId}' not found for project '${create.projectId}'.`
    )
  }
  if (!thread) {
    throw new AgentStorageError(
      "thread_not_found",
      `[${prefix}] Agent thread '${create.threadId}' not found for project '${create.projectId}'.`
    )
  }
  if (run.kind !== "conversation" || run.threadId !== create.threadId) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent run '${run.id}' does not belong to thread '${create.threadId}'.`
    )
  }
  if (run.status !== "running") {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent run '${run.id}' is not running (status '${run.status}').`
    )
  }
  if (!run.execution || run.execution.token !== create.executionToken) {
    throw new AgentStorageError(
      "execution_lost",
      `[${prefix}] Execution token is no longer current on agent run '${run.id}'.`
    )
  }
  if (thread.activeRunId !== run.id) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent run '${run.id}' no longer owns thread '${thread.id}'.`
    )
  }
}

/** Assert both compare-and-swap anchors and the retained-turn boundary. */
export function assertAgentContextCheckpointAnchors(input: {
  readonly create: CreateAgentContextCheckpointInput
  readonly latest: AgentContextCheckpointRecord | null
  readonly headSeq: number
  readonly firstRetained: AgentMessageRecord | null
  readonly prefix?: string
}): void {
  const { create, latest, headSeq, firstRetained } = input
  const prefix = input.prefix ?? "Sixb"
  if (headSeq !== create.expectedHeadSeq) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent thread '${create.threadId}' message head changed from ${create.expectedHeadSeq} to ${headSeq}.`
    )
  }

  const latestId = latest?.id ?? null
  if (latestId !== create.expectedPreviousCheckpointId) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent thread '${create.threadId}' checkpoint head changed.`
    )
  }
  if (latest && create.summarizedThroughSeq <= latest.summarizedThroughSeq) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint boundary must advance beyond sequence ${latest.summarizedThroughSeq}.`
    )
  }
  if (!firstRetained || firstRetained.seq !== create.summarizedThroughSeq + 1) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent context checkpoint boundary does not align with stored thread messages.`
    )
  }
  if (firstRetained.role !== "user") {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint must retain a complete turn beginning with a user message.`
    )
  }
}

/** Validate the mutable anchors again before returning an idempotently created checkpoint. */
export function assertAgentContextCheckpointReplayState(input: {
  readonly create: CreateAgentContextCheckpointInput
  readonly existing: AgentContextCheckpointRecord
  readonly latest: AgentContextCheckpointRecord | null
  readonly headSeq: number
  readonly prefix?: string
}): void {
  const prefix = input.prefix ?? "Sixb"
  if (input.headSeq !== input.create.expectedHeadSeq) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent thread '${input.create.threadId}' message head changed from ${input.create.expectedHeadSeq} to ${input.headSeq}.`
    )
  }
  if (input.latest?.id !== input.existing.id) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent thread '${input.create.threadId}' checkpoint head changed after '${input.existing.id}'.`
    )
  }
}

/** Compare the durable semantic payload; delivery token and generated timestamp are not content. */
export function agentContextCheckpointMatchesCreateInput(
  record: AgentContextCheckpointRecord,
  input: CreateAgentContextCheckpointInput
): boolean {
  return (
    record.id === input.id &&
    record.projectId === input.projectId &&
    record.threadId === input.threadId &&
    record.createdByRunId === input.createdByRunId &&
    (record.previousCheckpointId ?? null) === input.expectedPreviousCheckpointId &&
    record.reason === input.reason &&
    record.summary === input.summary &&
    record.summaryFormatVersion === input.summaryFormatVersion &&
    record.summarizedThroughSeq === input.summarizedThroughSeq &&
    record.observedHeadSeq === input.observedHeadSeq &&
    record.estimatedInputTokensBefore === input.estimatedInputTokensBefore &&
    record.estimatedInputTokensAfter === input.estimatedInputTokensAfter &&
    record.summaryModelId === input.summaryModelId
  )
}
