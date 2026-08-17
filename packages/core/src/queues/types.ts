import type { SixbErrorCode, SixbFailure } from "../errors/types"
import type { JsonValue } from "../json"
import type { ProjectionRunFailureCode } from "../projections/types"
import type { ProviderScope } from "../provider-scope"
import type { ActionRunFailureCode } from "../storage/action-runs/types"
import type { AgentRunFailureCode } from "../storage/agents/types"
import type { RecordAiModelCallInput } from "../storage/ai-usage"
import type { PipelineRunFailureCode } from "../storage/pipeline-runs/types"
import type { SyncRunFailureCode } from "../storage/sync-runs/types"
import type { WorkflowRunFailureCode } from "../storage/workflow-runs/types"

export interface QueueJobEnvelope {
  readonly id: string
  readonly projectId: string
  readonly createdAt: string
  readonly availableAt: string
  /** Increments each time the job is claimed, including redelivery after retries or lease expiry. */
  readonly attempt: number
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

export interface QueueJob<TType extends string = string, TPayload = unknown>
  extends QueueJobEnvelope {
  readonly type: TType
  readonly payload: TPayload
}

export type NewQueueJob<TQueueJob extends QueueJob> =
  TQueueJob extends QueueJob<infer TType, infer TPayload>
    ? {
        /** Stable provider-level id used to make enqueue idempotent when supplied. */
        readonly id?: string
        readonly type: TType
        readonly payload: TPayload
        readonly availableAt?: string
        readonly metadata?: Readonly<Record<string, JsonValue>>
      }
    : never

/** Portable terminal failure handed to a queue provider when a claimed job is abandoned. */
export type QueueJobFailure<TCode extends SixbErrorCode = SixbErrorCode> = SixbFailure<TCode>

/** Lane-specific aliases keep each primitive free to evolve its failure vocabulary independently. */
export type SyncQueueJobFailureCode = SyncRunFailureCode
export type PipelineQueueJobFailureCode = PipelineRunFailureCode
export type ProjectionQueueJobFailureCode = ProjectionRunFailureCode
export type WorkflowQueueJobFailureCode = WorkflowRunFailureCode
export type ActionQueueJobFailureCode = ActionRunFailureCode
export type AgentQueueJobFailureCode = AgentRunFailureCode

export interface ClaimedQueueJob<TQueueJob extends QueueJob = QueueJob> {
  /** Opaque acknowledgement token for this specific claim attempt. */
  readonly leaseId: string
  readonly claimedAt: string
  /** After this time, another worker may claim the job again if it was not acknowledged. */
  readonly leaseExpiresAt: string
  readonly job: TQueueJob
}

export interface Queue<
  TQueueJob extends QueueJob,
  TFailureCode extends SixbErrorCode = SixbErrorCode,
> {
  /**
   * Adds durable work to the lane. Jobs become claimable at `availableAt`, or immediately.
   * Repeating a caller-supplied job id is idempotent while that job remains in the provider.
   */
  enqueue(params: {
    projectId: string
    jobs: readonly NewQueueJob<TQueueJob>[]
  }): Promise<readonly TQueueJob[]>

  /**
   * Worker read path.
   *
   * Returns currently visible jobs and leases them to the caller so they can
   * be processed safely. Claimed jobs must later be completed, retried, or
   * failed with the returned lease id.
   *
   * `leaseMs` is the visibility timeout for this claim. If the lease expires
   * before the job is acknowledged, the job may be delivered again.
   */
  claim(params: {
    projectId: string
    workerId: string
    limit?: number
    leaseMs?: number
  }): Promise<readonly ClaimedQueueJob<TQueueJob>[]>

  /** Acknowledges successful processing and removes the claimed job from delivery. */
  complete(params: { projectId: string; jobId: string; leaseId: string }): Promise<void>

  /**
   * Releases the current lease and makes the job visible again now or at `availableAt`.
   *
   * The next successful claim will increment `attempt`.
   */
  retry(params: {
    projectId: string
    jobId: string
    leaseId: string
    availableAt?: string
  }): Promise<void>

  /**
   * Marks the claimed job as terminally failed so it will not be delivered again.
   *
   * The failure explains this terminal settlement; `retryable` may still be true when a worker's
   * policy exhausted its attempts. Queue providers may project the record into their native failed
   * job diagnostics. A queryable dead-letter history is deliberately a separate contract.
   */
  fail(params: {
    projectId: string
    jobId: string
    leaseId: string
    failure: QueueJobFailure<TFailureCode>
  }): Promise<void>

  /** Extends an active lease. Returns `null` if the lease was already lost, expired, or completed. */
  renewLease?(params: {
    projectId: string
    jobId: string
    leaseId: string
    leaseMs: number
  }): Promise<ClaimedQueueJob<TQueueJob> | null>
}

export interface SyncRunRequestedQueueJob
  extends QueueJob<
    "sync.run.requested",
    {
      readonly runId: string
    }
  > {}

export interface PipelineRunRequestedQueueJob
  extends QueueJob<
    "pipeline.run.requested",
    {
      readonly runId: string
    }
  > {}

export interface ProjectionRunRequestedQueueJob
  extends QueueJob<
    "projection.run.requested",
    {
      readonly runId: string
    }
  > {}

export interface WorkflowRunRequestedQueueJob
  extends QueueJob<
    "workflow.run.requested",
    {
      readonly runId: string
    }
  > {}

/** Wake a durable wait edge; the worker resolves its type and current state from storage. */
export interface WorkflowRunResumeRequestedQueueJob
  extends QueueJob<
    "workflow.run.resume.requested",
    {
      readonly runId: string
      readonly nodeRunId: string
    }
  > {}

export type WorkflowQueueJob = WorkflowRunRequestedQueueJob | WorkflowRunResumeRequestedQueueJob

export interface ActionRunRequestedQueueJob
  extends QueueJob<
    "action.run.requested",
    {
      readonly runId: string
    }
  > {}

/**
 * An agent turn is requested for a thread. The payload points to the durable queued run created
 * with the user message; the worker transitions it to running and installs the delivery's execution
 * token when this job is claimed.
 */
export interface AgentRunRequestedQueueJob
  extends QueueJob<
    "agent.run.requested",
    {
      readonly runId: string
    }
  > {}

export interface AgentWorkflowNodeRequestedQueueJob
  extends QueueJob<
    "agent.workflow-node.requested",
    {
      readonly nodeRunId: string
    }
  > {}

/** JSON-safe representation of one model-call ledger append awaiting durable recovery. */
export type AgentAiUsageRecordPayload = Omit<
  RecordAiModelCallInput,
  "projectId" | "usage" | "occurredAt" | "recordedAt"
> & {
  readonly usage: {
    readonly [Field in keyof RecordAiModelCallInput["usage"]]: RecordAiModelCallInput["usage"][Field]
  }
  readonly occurredAt: string
}

export interface AgentAiUsageRecordRequestedQueueJob
  extends QueueJob<
    "agent.ai-usage.record.requested",
    {
      readonly record: AgentAiUsageRecordPayload
    }
  > {}

export type AgentQueueJob =
  | AgentRunRequestedQueueJob
  | AgentWorkflowNodeRequestedQueueJob
  | AgentAiUsageRecordRequestedQueueJob

export interface Queues {
  readonly syncRuns: Queue<SyncRunRequestedQueueJob, SyncQueueJobFailureCode>
  readonly pipelines: Queue<PipelineRunRequestedQueueJob, PipelineQueueJobFailureCode>
  readonly projections: Queue<ProjectionRunRequestedQueueJob, ProjectionQueueJobFailureCode>
  readonly workflows: Queue<WorkflowQueueJob, WorkflowQueueJobFailureCode>
  readonly actions: Queue<ActionRunRequestedQueueJob, ActionQueueJobFailureCode>
  readonly agents: Queue<AgentQueueJob, AgentQueueJobFailureCode>

  /**
   * Whether these queues can be shared across processes.
   *
   * A `"process"` provider gives every role its own private lane, so jobs are
   * enqueued where nobody claims them and the system looks alive while doing
   * nothing. Production roles refuse to start against one. See
   * {@link ProviderScope} for why it is required rather than inferred.
   */
  readonly scope: ProviderScope

  /**
   * Reports whether the backing service is reachable, without enqueueing or claiming.
   *
   * The only read-only member of this contract, and required for that reason: `sixb check`
   * used to paint its queues row green without a round trip, and an optional probe would
   * have left the same hole open for anyone who skipped it. Resolve when reachable, throw
   * otherwise — the message reaches an operator, so it has to name the condition.
   */
  health(): Promise<void>

  /** Release external resources. Optional: a provider that owns none omits it. */
  close?(): void | Promise<void>
}
