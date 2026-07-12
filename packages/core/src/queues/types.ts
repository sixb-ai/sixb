import type { Principal } from "../auth"
import type { JsonValue } from "../json"
import type { WorkflowRunSource } from "../workflows/types"

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

export interface QueueJobError {
  readonly name?: string
  readonly message: string
}

export interface ClaimedQueueJob<TQueueJob extends QueueJob = QueueJob> {
  /** Opaque acknowledgement token for this specific claim attempt. */
  readonly leaseId: string
  readonly claimedAt: string
  /** After this time, another worker may claim the job again if it was not acknowledged. */
  readonly leaseExpiresAt: string
  readonly job: TQueueJob
}

export interface Queue<TQueueJob extends QueueJob> {
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
    error?: QueueJobError
  }): Promise<void>

  /** Marks the claimed job as terminally failed so it will not be delivered again. */
  fail(params: {
    projectId: string
    jobId: string
    leaseId: string
    error: QueueJobError
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
      readonly syncId: string
      readonly runId?: string
      readonly expectedLatestVersionId?: string
      readonly commitMessage?: string
    }
  > {}

export interface PipelineRunRequestedQueueJob
  extends QueueJob<
    "pipeline.run.requested",
    {
      readonly pipelineId: string
      readonly runId?: string
    }
  > {}

export interface ProjectionRunRequestedQueueJob
  extends QueueJob<
    "projection.run.requested",
    {
      readonly projectionId: string
      readonly projectionKind: "object" | "link" | "telemetry"
      readonly datasetId: string
      readonly versionId: string
    }
  > {}

export interface WorkflowRunRequestedQueueJob
  extends QueueJob<
    "workflow.run.requested",
    {
      readonly workflowId: string
      readonly runId?: string
      readonly input?: Readonly<Record<string, unknown>>
      readonly source?: WorkflowRunSource
    }
  > {}

export interface WorkflowRunResumeRequestedQueueJob
  extends QueueJob<
    "workflow.run.resume.requested",
    {
      readonly workflowId: string
      readonly runId: string
      readonly pendingInterventionId: string
    }
  > {}

export type WorkflowQueueJob = WorkflowRunRequestedQueueJob | WorkflowRunResumeRequestedQueueJob

export interface ActionRunRequestedQueueJob
  extends QueueJob<
    "action.run.requested",
    {
      readonly actionId: string
      readonly runId: string
    }
  > {}

/**
 * An agent turn is requested for a thread. The payload carries the intent plus the request-time run
 * id; the worker reserves the run row when it claims the queue job.
 */
export interface AgentRunRequestedQueueJob
  extends QueueJob<
    "agent.run.requested",
    {
      readonly agentId: string
      readonly threadId: string
      readonly runId: string
      readonly triggerMessageId: string
      readonly requestedByPrincipal?: Principal
    }
  > {}

export interface Queues {
  readonly syncRuns: Queue<SyncRunRequestedQueueJob>
  readonly pipelines: Queue<PipelineRunRequestedQueueJob>
  readonly projections: Queue<ProjectionRunRequestedQueueJob>
  readonly workflows: Queue<WorkflowQueueJob>
  readonly actions: Queue<ActionRunRequestedQueueJob>
  readonly agents: Queue<AgentRunRequestedQueueJob>
}
