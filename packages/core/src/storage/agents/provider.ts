import { agentServiceAccountId } from "../../agents/authority"
import { MAIN_AGENT_ID } from "../../agents/main"
import type { ExecutionStorage } from "../executions"
import { findAgentRunExecution } from "../executions/run-link"
import { AgentStorageError } from "./errors"
import type {
  AgentContextCheckpointRecord,
  AgentMessageRecord,
  AgentRunRecord,
  AgentThreadRecord,
  CreateAgentContextCheckpointInput,
} from "./types"

/** Validate the semantic link between a conversational Agent run and its immutable execution. */
export async function assertAgentRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly agentId: string
}): Promise<void> {
  const execution = await findAgentRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    runId: input.runId,
    // Transitional: run kind will replace the reserved id as the authority discriminator.
    authority:
      input.agentId === MAIN_AGENT_ID
        ? { type: "inherited" }
        : { type: "managed", serviceAccountId: agentServiceAccountId(input.agentId) },
  })
  if (!execution) {
    throw new AgentStorageError(
      "invalid_input",
      `[Sixb] Execution '${input.executionId}' does not authorize Agent run '${input.runId}'.`
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
  if (run.threadId !== create.threadId) {
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
