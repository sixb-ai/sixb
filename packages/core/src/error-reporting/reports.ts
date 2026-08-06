import { randomUUID } from "node:crypto"
import type { ActionRunFailure } from "../storage/action-runs"
import type { ErrorReporter } from "./reporter"
import type { SixbFailedRun } from "./types"

function resolveOccurredAt(occurredAt?: Date | string): string {
  if (occurredAt instanceof Date) return occurredAt.toISOString()
  return occurredAt ?? new Date().toISOString()
}

export interface ReportRunFailureInput {
  readonly projectId: string
  readonly run: SixbFailedRun
  readonly occurredAt?: Date | string
  readonly attempt?: number
}

export function reportRunFailure(
  reporter: ErrorReporter,
  error: unknown,
  input: ReportRunFailureInput
): void {
  const occurredAt = resolveOccurredAt(input.occurredAt)
  reporter.report(error, {
    type: "run.failed",
    notificationId: `project:${input.projectId}:run:${input.run.kind}:${input.run.runId}:failed:${occurredAt}`,
    projectId: input.projectId,
    occurredAt,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    run: input.run,
  })
}

export interface ReportActionPhaseFailureInput {
  readonly projectId: string
  readonly actionId: string
  readonly runId: string
  readonly phase: "effects"
  readonly failure: ActionRunFailure<"effects">
}

export function reportActionPhaseFailure(
  reporter: ErrorReporter,
  error: unknown,
  input: ReportActionPhaseFailureInput
): void {
  reporter.report(error, {
    type: "action.phase.failed",
    notificationId: `project:${input.projectId}:action:${input.actionId}:run:${input.runId}:phase:${input.phase}:failed:${input.failure.at}`,
    projectId: input.projectId,
    occurredAt: input.failure.at,
    actionId: input.actionId,
    runId: input.runId,
    phase: input.phase,
    failure: input.failure,
  })
}

export interface ReportEventDeliveryFailureInput {
  readonly projectId: string
  /** Event types that never reached subscribers. Payloads must not be passed in. */
  readonly eventTypes: readonly string[]
  readonly occurredAt?: Date | string
  /** Delivery attempts so far. Defaults to 1, which is right for a rejected emit. */
  readonly attempts?: number
  /** Envelope ids, when the events were persisted before delivery failed. */
  readonly eventIds?: readonly string[]
  /**
   * Identity of this loss, used only when nothing was persisted. Defaults to a fresh id; pass one to
   * make a report reproducible in a test.
   */
  readonly occurrenceId?: string
}

/**
 * Report that domain events were lost.
 *
 * Both delivery paths land here: the outbox dispatcher, which has persisted envelope ids and retries,
 * and a rejected `events.emit()`, which has only the types. Reporting must work for both — an earlier
 * version returned early on an empty `eventIds`, which silently dropped exactly the case this exists
 * to surface.
 *
 * Each path keys on the strongest identity it has. The outbox persisted its envelopes, so the ids plus
 * the attempt number name the loss exactly and stay stable if one report is delivered twice. A rejected
 * emit persisted nothing and is always terminal at attempt 1, so the type list alone was its whole
 * correlation — and two schedules losing `schedule.triggered` in the same broker outage are dispatched
 * concurrently, land in the same millisecond, and were therefore one notification. A timestamp does not
 * fix that; an identity does.
 */
export function reportEventDeliveryFailure(
  reporter: ErrorReporter,
  error: unknown,
  input: ReportEventDeliveryFailureInput
): void {
  const occurredAt = resolveOccurredAt(input.occurredAt)
  const attempts = input.attempts ?? 1
  const eventIds = input.eventIds === undefined ? undefined : [...input.eventIds].sort()
  const firstEventId = eventIds?.[0]
  const occurrence = firstEventId
    ? `events:${firstEventId}:attempt:${attempts}`
    : `emit:${input.occurrenceId ?? randomUUID()}`
  reporter.report(error, {
    type: "event.delivery.failed",
    notificationId: `project:${input.projectId}:event-delivery:${occurrence}`,
    projectId: input.projectId,
    occurredAt,
    attempts,
    eventTypes: input.eventTypes,
    ...(eventIds === undefined ? {} : { eventIds }),
  })
}

export interface ReportRuleEvaluationFailureInput {
  readonly projectId: string
  readonly source: "live" | "reconciliation"
  readonly eventIds?: readonly string[]
  readonly occurredAt?: Date | string
  /** Set when the failure could be attributed to one rule/subject candidate. */
  readonly ruleId?: string
  readonly subject?: { readonly objectTypeId: string; readonly primaryId: string }
}

export function reportRuleEvaluationFailure(
  reporter: ErrorReporter,
  error: unknown,
  input: ReportRuleEvaluationFailureInput
): void {
  const occurredAt = resolveOccurredAt(input.occurredAt)
  const eventIds = [...(input.eventIds ?? [])].sort()
  // A candidate-level failure keys on the candidate, so two rules failing over the same batch stay
  // two notifications rather than collapsing into one.
  const occurrence =
    input.ruleId && input.subject
      ? `${input.ruleId}:${input.subject.objectTypeId}:${input.subject.primaryId}`
      : (eventIds[0] ?? "current-state")
  reporter.report(error, {
    type: "rule.evaluation.failed",
    notificationId: `project:${input.projectId}:rule-evaluation:${input.source}:${occurrence}:failed:${occurredAt}`,
    projectId: input.projectId,
    occurredAt,
    source: input.source,
    eventIds,
    ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
  })
}
