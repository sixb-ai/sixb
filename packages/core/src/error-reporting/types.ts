import type { SixbFailure } from "../errors/types"
import type { ActionRunFailure } from "../storage/action-runs"
import type { AgentRunFailureCode } from "../storage/agents"
import type { VectorIndexingFailureCode } from "../storage/ontology/vector-indexing"
import type { PipelineRunFailureCode } from "../storage/pipeline-runs"
import type { ProjectionRunFailureCode } from "../storage/projection-runs"
import type { SyncRunFailureCode } from "../storage/sync-runs"
import type { WebhookRunFailureCode } from "../storage/webhook-runs"
import type { WorkflowRunFailureCode } from "../storage/workflow-runs"

/** Correlation fields exposed by `run.failed`, indexed by run primitive. */
export interface SixbRunIdentityByKind {
  readonly action: {
    readonly runId: string
    readonly actionId: string
  }
  readonly agent: {
    readonly runId: string
  } & (
    | { readonly threadId: string; readonly parentRunId?: never }
    | { readonly parentRunId: string; readonly threadId?: never }
  )
  readonly pipeline: {
    readonly runId: string
    readonly pipelineId: string
  }
  readonly projection: {
    readonly runId: string
    readonly projectionId: string
    readonly projectionKind: "object" | "link" | "telemetry"
  }
  readonly sync: {
    readonly runId: string
    readonly syncId: string
  }
  readonly workflow: {
    readonly runId: string
    readonly workflowId: string
  }
  readonly webhook: {
    readonly runId: string
    readonly connectorId: string
    readonly webhookId: string
  }
}

/** Canonical failure record exposed by `run.failed`, indexed by run primitive. */
export interface SixbRunFailureByKind {
  readonly action: ActionRunFailure
  readonly agent: SixbFailure<AgentRunFailureCode>
  readonly pipeline: SixbFailure<PipelineRunFailureCode>
  readonly projection: SixbFailure<ProjectionRunFailureCode>
  readonly sync: SixbFailure<SyncRunFailureCode>
  readonly workflow: SixbFailure<WorkflowRunFailureCode>
  readonly webhook: SixbFailure<WebhookRunFailureCode>
}

/**
 * The failed unit of work, discriminated by primitive. Each variant carries the correlation its
 * primitive actually has and the exact failure persisted by that run. There is exactly one variant
 * per `SixbRunKind`.
 *
 * Rules are deliberately absent: they are evaluated live, per subject, with no run record, so they
 * report through `SixbRuleEvaluationFailedContext` instead of being handed a `runId` that would name
 * an entity nothing can resolve.
 */
export type SixbFailedRun = {
  readonly [TKind in keyof SixbRunIdentityByKind]: {
    /** Top-level discriminant so TypeScript narrows both `run` and `failure` without casts. */
    readonly runKind: TKind
    readonly run: SixbRunIdentityByKind[TKind]
    readonly failure: SixbRunFailureByKind[TKind]
  }
}[keyof SixbRunIdentityByKind]

interface SixbFailureContext<TType extends string> {
  readonly type: TType
  /**
   * Stable key for this one failure occurrence, usable as an idempotency key when notifying.
   *
   * Two distinct failures never share it. Each context keys on the strongest identity its failure has —
   * a run id, a rule and subject, persisted envelope ids — and a failure with no such identity carries
   * one of its own rather than borrowing a timestamp, which concurrent failures share.
   */
  readonly notificationId: string
  readonly projectId: string
  readonly occurredAt: string
}

export type SixbRunFailedContext = SixbFailureContext<"run.failed"> &
  SixbFailedRun & {
    /** Queue delivery attempt, when the run was executed through a queue. */
    readonly attempt?: number
  }

/**
 * A post-commit Action phase failed without changing the committed Action outcome.
 *
 * Effects run after the run is recorded with its commit, so the run remains succeeded while this
 * context exposes the exact phase failure recorded on it.
 */
export interface SixbActionPhaseFailedContext extends SixbFailureContext<"action.phase.failed"> {
  readonly actionId: string
  readonly runId: string
  readonly phase: "effects"
  readonly failure: ActionRunFailure<"effects">
}

/**
 * A batch of domain events never reached its subscribers.
 *
 * Every event Sixb publishes is a potential trigger edge — a rule's `.when()`, an event schedule, a
 * workflow's wait node — so a lost batch is a handler that silently never runs.
 *
 * Two paths report here, which is why `eventIds` is optional. The outbox dispatcher persists envelopes
 * before publishing them, so it has ids and reports a rising `attempts` as it retries. A rejected
 * `events.emit()` never got that far: nothing was persisted, so only the types are known and the
 * failure is terminal at `attempts: 1`. `eventTypes` is the field both paths can always fill, and the
 * one an operator reads first.
 */
export interface SixbEventDeliveryFailedContext
  extends SixbFailureContext<"event.delivery.failed"> {
  /** Canonical delivery failure, also persisted when the outbox owns the delivery. */
  readonly failure: SixbFailure<"event.delivery_failed">
  /** Delivery attempts so far. A rejected emit is terminal, so it reports 1. */
  readonly attempts: number
  /** Which event types never reached subscribers. Payloads are never included. */
  readonly eventTypes: readonly string[]
  /**
   * Stable envelope IDs, present only when the events were persisted before delivery failed.
   * Payloads and lease identifiers are never exposed.
   */
  readonly eventIds?: readonly string[]
}

/**
 * A rule evaluation failed.
 *
 * `source` is the field to alert on. A failing `live` evaluation is recoverable: the periodic
 * reconciliation pass rebuilds rule state from committed objects, so the affected subjects are
 * re-evaluated within one interval. A failing `reconciliation` pass is not — it *is* the repair path,
 * so while it keeps failing, rule state stops converging.
 *
 * `ruleId` and `subject` are present whenever the failure could be attributed to one candidate. They
 * are absent when the failure took down a whole batch or pass before any single candidate could be
 * blamed, which is itself the case worth escalating.
 */
export interface SixbRuleEvaluationFailedContext
  extends SixbFailureContext<"rule.evaluation.failed"> {
  /**
   * Canonical snapshot of the thrown value. Rule failures remain `internal.unexpected` until the
   * evaluator can distinguish deterministic rule failures from retryable dependency failures.
   */
  readonly failure: SixbFailure<"internal.unexpected">
  readonly source: "live" | "reconciliation"
  /** Envelope IDs involved in a live evaluation; empty for reconciliation. */
  readonly eventIds: readonly string[]
  readonly ruleId?: string
  readonly subject?: { readonly objectTypeId: string; readonly primaryId: string }
}

/**
 * What people changed in a canvas live was never stored: the server stopped before it could write
 * it back, or storage refused it with nobody left who may write it. Until then a failed write-back
 * is only logged: the server keeps the changes and tries again while it runs.
 */
export interface SixbArtifactLiveWriteFailedContext
  extends SixbFailureContext<"artifact.live_write.failed"> {
  /** The last write-back's failure. */
  readonly failure: SixbFailure<"storage.unavailable" | "internal.unexpected">
  readonly artifactId: string
  /** The revision the unwritten changes were made on. */
  readonly revision: number
  /** The write-backs tried, none of which was stored. */
  readonly attempts: number
}

/** A terminal automatic-indexing failure, correlated with its persisted request and profile. */
export interface SixbVectorIndexingFailedContext
  extends SixbFailureContext<"vector.indexing.failed"> {
  readonly failure: SixbFailure<VectorIndexingFailureCode>
  readonly indexingId: string
  readonly objectTypeId: string
  readonly primaryId: string
  readonly profile: string
}

/**
 * One pass of the maintenance loop failed, or ran past its budget. It runs again when it is next
 * due, so one report is a blip; `consecutiveFailures` is the field to alert on. `heartbeat` as
 * `passId` means the loop could not write its heartbeat.
 */
export interface SixbMaintenancePassFailedContext
  extends SixbFailureContext<"maintenance.pass.failed"> {
  readonly failure: SixbFailure<"internal.unexpected">
  readonly passId: string
  readonly consecutiveFailures: number
}

/**
 * A job of an event could not be dispatched, and `dropped` says what became of it.
 *
 * True: the failure is about this event, such as a mapper that throws, so retrying cannot help and
 * this trigger is gone. False: the job has failed for minutes and keeps retrying. An outage reads
 * like this. So does a defect that no retry will fix, so a job that stays here wants a look.
 */
export interface SixbOrchestratorDispatchFailedContext
  extends SixbFailureContext<"orchestrator.dispatch.failed"> {
  readonly failure: SixbFailure<"internal.unexpected">
  readonly eventId: string
  readonly eventType: string
  /** What the job starts, such as `pipeline:daily-sales`. */
  readonly target: string
  readonly attempts: number
  readonly dropped: boolean
}

/**
 * One automatic lake retention run failed. The lake keeps what that run would have removed; the
 * next interval's run tries again.
 */
export interface SixbLakeRetentionFailedContext
  extends SixbFailureContext<"lake.retention.failed"> {
  readonly failure: SixbFailure<"internal.unexpected" | "runtime.cancelled">
  /** The start of the interval the run was for. */
  readonly intervalStart: string
}

/**
 * A dataset's ingested changes have waited too long: its flushes failed this many times in a row,
 * or none ran at all. The changes stay in the inbox, and flushes go on trying.
 */
export interface SixbDatasetIngestFlushFailedContext
  extends SixbFailureContext<"dataset.ingest.flush.failed"> {
  readonly failure: SixbFailure<"internal.unexpected" | "runtime.cancelled">
  readonly datasetId: string
  /** Flush attempts that failed in a row. 0 when no flush ran. */
  readonly failureStreak: number
  readonly pendingDeliveries: number
  readonly oldestReceivedAt: string | null
}

/**
 * The lake refused one ingested delivery when its flush wrote it, after `ingest` had accepted it:
 * for example a source sequence another delivery holds with other content. The delivery is
 * dropped and the rest of its batch committed. The context names what to send again.
 */
export interface SixbDatasetIngestRejectedContext
  extends SixbFailureContext<"dataset.ingest.rejected"> {
  readonly failure: SixbFailure<"dataset.change_refused">
  readonly datasetId: string
  readonly deliveryId: string
  /** The execution that called `ingest`. */
  readonly executionId: string
  /** How many changes the delivery held. `sixb lake rejected` shows all of them. */
  readonly changes: number
  /** The refused change's position in the delivery, from 0. */
  readonly changeIndex: number
  /** The refused change's primary key. */
  readonly key: Readonly<Record<string, string>>
  /** Its source sequence, on a dataset with `sequenceBy`. */
  readonly sequence?: string
}

/**
 * Context supplied to the global Sixb error handler, discriminated by `type`.
 * Failure notifications never change the outcome of the operation they observe.
 */
export type SixbErrorContext =
  | SixbArtifactLiveWriteFailedContext
  | SixbVectorIndexingFailedContext
  | SixbLakeRetentionFailedContext
  | SixbDatasetIngestFlushFailedContext
  | SixbDatasetIngestRejectedContext
  | SixbActionPhaseFailedContext
  | SixbRunFailedContext
  | SixbEventDeliveryFailedContext
  | SixbRuleEvaluationFailedContext
  | SixbMaintenancePassFailedContext
  | SixbOrchestratorDispatchFailedContext

/** Observes runtime failures without changing their outcome. */
export type SixbErrorHandler = (error: Error, context: SixbErrorContext) => void | Promise<void>
