import type { ReadonlyJsonObject } from "../../json"

/** How much normalized token usage a provider reported for one model call. */
export type AiUsageReportingStatus = "complete" | "partial" | "unavailable"

/** Provider-neutral token counts accepted at the model-call boundary. */
export interface AiModelCallUsageInput {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly uncachedInputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly textOutputTokens?: number
  readonly reasoningOutputTokens?: number
}

/** Normalized token counts for one completed model call. Details overlap their input/output totals. */
export interface AiModelCallUsage extends AiModelCallUsageInput {
  /** Present only when both input and output totals are known. */
  readonly totalTokens?: number
  readonly reportingStatus: AiUsageReportingStatus
}

/** Aggregated usage and call presence for one durable execution. */
export interface AiUsageExecutionSummary {
  /** Number of idempotent model-call ledger records included across every delivery attempt. */
  readonly modelCallCount: number
  /** Unavailable with a positive call count means the provider reported no normalized counts. */
  readonly usage: AiModelCallUsage
}

/** Input for an idempotent model-call ledger append. */
export interface RecordAiModelCallInput {
  readonly id: string
  readonly projectId: string
  /** Immutable execution-ledger record that owns this provider call. */
  readonly executionId: string
  /** Queue delivery attempt that made the provider call. */
  readonly attempt: number
  /** AI SDK generation ID. Tool-loop model calls share it and are distinguished by responseId. */
  readonly callId: string
  /**
   * Durable group memberships snapshotted when the parent run was admitted. The requester itself
   * is read from the immutable execution record.
   */
  readonly requesterGroupIds: readonly string[]
  /** AI SDK provider that handled the call, such as `openai`, `anthropic`, or `gateway`. */
  readonly providerId: string
  readonly requestedModelId: string
  /** Provider-returned model identity when the capture path exposes it. */
  readonly responseModelId?: string
  /** Provider-returned response ID used for later usage and cost reconciliation. */
  readonly responseId: string
  readonly usage: AiModelCallUsageInput
  readonly rawUsage?: ReadonlyJsonObject
  /** When the provider call completed, used for historical pricing and accounting periods. */
  readonly occurredAt: Date
  readonly recordedAt?: Date
}

/** Immutable accounting record for one completed provider model call. */
export interface AiModelCallUsageRecord extends RecordAiModelCallInput {
  readonly usage: AiModelCallUsage
  readonly recordedAt: Date
}

export interface RecordAiModelCallResult {
  readonly record: AiModelCallUsageRecord
  /** False when the idempotency key already existed and its record was returned. */
  readonly created: boolean
}

export interface SummarizeAiUsageExecutionInput {
  readonly projectId: string
  readonly executionId: string
}

export interface SummarizeAiUsageExecutionsInput {
  readonly projectId: string
  readonly executionIds: readonly string[]
}

export interface GetLatestAiModelCallForExecutionInput {
  readonly projectId: string
  readonly executionId: string
}

/** Durable, provider-neutral accounting for completed language-model calls. */
export interface AiUsageStorage {
  /**
   * Append one model-call record idempotently. The identity is project, execution ID, attempt, call
   * ID, and response ID; retrying that identity returns the existing record with `created: false`.
   */
  recordModelCall(input: RecordAiModelCallInput): Promise<RecordAiModelCallResult>

  /** Latest completed provider call for one execution, ordered by occurrence and stable id. */
  getLatestForExecution(
    input: GetLatestAiModelCallForExecutionInput
  ): Promise<AiModelCallUsageRecord | null>

  /** Aggregate normalized usage and call presence across every attempt of one execution. */
  summarizeExecution(input: SummarizeAiUsageExecutionInput): Promise<AiUsageExecutionSummary>

  /**
   * Aggregate multiple executions in one storage read. Results have the same length and order as
   * `executionIds`. Executions without ledger records have a zero model-call count and unavailable
   * usage.
   */
  summarizeExecutions(
    input: SummarizeAiUsageExecutionsInput
  ): Promise<readonly AiUsageExecutionSummary[]>
}
