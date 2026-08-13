import type { SixbFailure } from "../errors/types"
import type { ActionRunFailure } from "../storage/action-runs"
import type { AgentRunFailureCode } from "../storage/agents"
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
    readonly agentId: string
  }
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

/** A post-commit Action effects phase failed without changing the committed Action outcome. */
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
 * Context supplied to the global Sixb error handler, discriminated by `type`.
 *
 * Failure notifications never change the outcome of the operation they observe.
 */
export type SixbErrorContext =
  | SixbActionPhaseFailedContext
  | SixbRunFailedContext
  | SixbEventDeliveryFailedContext
  | SixbRuleEvaluationFailedContext

/** Observes runtime failures without changing their outcome. */
export type SixbErrorHandler = (error: Error, context: SixbErrorContext) => void | Promise<void>
