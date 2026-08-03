import type { SixbFailure } from "../errors"

/**
 * The failed unit of work, discriminated by primitive. Each variant carries the correlation its
 * primitive actually has, and there is exactly one variant per `SixbRunKind`.
 *
 * Rules are deliberately absent: they are evaluated live, per subject, with no run record, so they
 * report through `SixbRuleEvaluationFailedContext` instead of being handed a `runId` that would name
 * an entity nothing can resolve.
 */
export type SixbFailedRun =
  | {
      readonly kind: "action"
      readonly runId: string
      readonly actionId: string
    }
  | {
      readonly kind: "agent"
      readonly runId: string
      readonly agentId: string
    }
  | {
      readonly kind: "pipeline"
      readonly runId: string
      readonly pipelineId: string
    }
  | {
      readonly kind: "projection"
      readonly runId: string
      readonly projectionId: string
      readonly projectionKind: "object" | "link" | "telemetry"
    }
  | {
      readonly kind: "sync"
      readonly runId: string
      readonly syncId: string
    }
  | {
      readonly kind: "workflow"
      readonly runId: string
      readonly workflowId: string
    }
  | {
      readonly kind: "webhook"
      readonly runId: string
      readonly connectorId: string
      readonly webhookId: string
    }

/**
 * The background work of the runtime, named.
 *
 * Closed, for the reason every other Sixb vocabulary is (`SIXB_RUN_KINDS`, `SIXB_ERROR_CODES`): a
 * handler routes on it — this task pages, that one opens a ticket — and a free string makes that
 * routing a typo away from silence.
 *
 * These are the loops that keep a project moving without anyone asking them to. None of them is a
 * run, so none has a row to record a failure on, which is why each was a `console.error` reaching
 * nobody before this existed.
 */
export const SIXB_BACKGROUND_TASKS = [
  /** Handing a queued agent run to its worker. */
  "agent.dispatch",
  /** Publishing committed ontology facts as domain events. */
  "ontology.outbox",
  /** The periodic pass that repairs projections and re-drives a stalled outbox. */
  "ontology.maintenance",
  /** Turning a domain event into the queue jobs and event schedules it routes to. */
  "orchestrator.dispatch",
  /** Re-driving projection dispatch for datasets the live path missed. */
  "orchestrator.projection-reconcile",
  /** Holding the event subscription a project's live routing depends on. */
  "orchestrator.subscribe",
  /** Keeping the lease on a claimed queue job. */
  "queue.lease",
  /** Acking, failing, or releasing a queue job once its work is done. */
  "queue.settle",
  /** Planning when a cron schedule fires next. */
  "schedule.plan",
  /** Re-entering a workflow once the node it was waiting on finished. */
  "workflow.resume",
] as const

/** One of the runtime's own background loops. See {@link SIXB_BACKGROUND_TASKS}. */
export type SixbBackgroundTask = (typeof SIXB_BACKGROUND_TASKS)[number]

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

export interface SixbRunFailedContext extends SixbFailureContext<"run.failed"> {
  /** Queue delivery attempt, when the run was executed through a queue. */
  readonly attempt?: number
  readonly run: SixbFailedRun
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
  /** Delivery attempts so far. A rejected emit is terminal, so it reports 1. */
  readonly attempts: number
  /** Which event types never reached subscribers. Payloads are never included. */
  readonly eventTypes: readonly string[]
  /**
   * The framework component that was emitting, as it labels itself (`SixbActionWorker`). Present on
   * the emit path, where the emitter is the first thing an operator wants to know; absent on the
   * outbox path, which is the runtime itself.
   */
  readonly source?: string
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
  readonly source: "live" | "reconciliation"
  /** Envelope IDs involved in a live evaluation; empty for reconciliation. */
  readonly eventIds: readonly string[]
  readonly ruleId?: string
  readonly subject?: { readonly objectTypeId: string; readonly primaryId: string }
}

/**
 * One of the runtime's background loops failed.
 *
 * The other three contexts name work someone asked for. This one names work nobody asked for and
 * everything depends on: a dispatcher that cannot claim is a project where nothing runs, and a
 * schedule whose next occurrence cannot be computed stops firing for good. Neither has a run row,
 * so neither has anywhere to be seen — which is what makes them the failures most worth escalating,
 * not the least.
 *
 * `subject` is what the task was working on when it failed, when there was one thing: a run id, an
 * event type, a queue job. It is free text because a task chooses its own — branch on `task`.
 */
export interface SixbBackgroundTaskFailedContext
  extends SixbFailureContext<"background.task.failed"> {
  readonly task: SixbBackgroundTask
  readonly subject?: string
}

/**
 * Context supplied to the global Sixb error handler, discriminated by `type`.
 *
 * Failure notifications never change the outcome of the operation they observe.
 */
export type SixbErrorContext =
  | SixbRunFailedContext
  | SixbEventDeliveryFailedContext
  | SixbRuleEvaluationFailedContext
  | SixbBackgroundTaskFailedContext

/**
 * Observes runtime failures without changing their outcome.
 *
 * The first argument is the same {@link SixbFailure} the run row stores and the API returns — the
 * record itself, handed over, not a second reading of the thrown value — so a handler branches on
 * `failure.code` knowing it is the code an operator sees on the run. The second is where the
 * failure happened.
 *
 * A primitive that extends the record hands over the extension too: an action run's failure arrives
 * carrying its `phase`. The parameter still says `SixbFailure`, the one shape every path shares, so
 * reading `phase` means checking `context.run.kind === "action"` and narrowing. Typing this argument
 * per context would make every handler generic to buy one field that only one context has.
 *
 * `context.cause` is the value that was actually thrown, alive and with its stack. It is deliberately
 * not part of the record: `failure.cause` is the string an operator reads, and this is the object a
 * reporter like Sentry attaches. Nothing serializes it.
 *
 * Sixb prints every failure it reports when no handler is configured, so leaving this unset is not
 * silence. Passing `() => {}` is.
 */
export type SixbErrorHandler = (
  failure: SixbFailure,
  context: SixbErrorContext & { readonly cause: unknown }
) => void | Promise<void>
