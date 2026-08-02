import { randomUUID } from "node:crypto"
import { SixbErrorReporter } from "./reporter"
import type { SixbBackgroundTask, SixbErrorHandler, SixbFailedRun } from "./types"

function resolveOccurredAt(occurredAt?: Date | string): string {
  if (occurredAt instanceof Date) return occurredAt.toISOString()
  return occurredAt ?? new Date().toISOString()
}

const ERROR_REPORTER = Symbol("sixb.error-reporter")

type ErrorReporterHost = {
  [ERROR_REPORTER]?: SixbErrorReporter
}

function asHost(value: unknown): ErrorReporterHost | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return null
  }
  return value as ErrorReporterHost
}

export function attachSixbErrorReporter(
  host: object,
  handler?: SixbErrorHandler
): SixbErrorReporter {
  const reporter = new SixbErrorReporter(handler)
  ;(host as ErrorReporterHost)[ERROR_REPORTER] = reporter
  return reporter
}

export function shareSixbErrorReporter(source: object, target: object): void {
  const reporter = (source as ErrorReporterHost)[ERROR_REPORTER]
  if (reporter) (target as ErrorReporterHost)[ERROR_REPORTER] = reporter
}

export interface ReportRunFailureInput {
  readonly projectId: string
  readonly run: SixbFailedRun
  readonly occurredAt?: Date | string
  readonly attempt?: number
}

export function reportRunFailure(
  host: unknown,
  error: unknown,
  input: ReportRunFailureInput
): void {
  const reporter = asHost(host)?.[ERROR_REPORTER]
  if (!reporter) return

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

export interface ReportEventDeliveryFailureInput {
  readonly projectId: string
  /** Event types that never reached subscribers. Payloads must not be passed in. */
  readonly eventTypes: readonly string[]
  readonly occurredAt?: Date | string
  /** Delivery attempts so far. Defaults to 1, which is right for a rejected emit. */
  readonly attempts?: number
  /** Envelope ids, when the events were persisted before delivery failed. */
  readonly eventIds?: readonly string[]
  /** The framework component that was emitting, on the emit path. */
  readonly source?: string
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
  host: unknown,
  error: unknown,
  input: ReportEventDeliveryFailureInput
): void {
  const reporter = asHost(host)?.[ERROR_REPORTER]
  if (!reporter) return

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
    ...(input.source === undefined ? {} : { source: input.source }),
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
  host: unknown,
  error: unknown,
  input: ReportRuleEvaluationFailureInput
): void {
  const reporter = asHost(host)?.[ERROR_REPORTER]
  if (!reporter) return

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

export interface ReportBackgroundTaskFailureInput {
  readonly projectId: string
  readonly task: SixbBackgroundTask
  /** What the task was working on, when it was working on one thing. */
  readonly subject?: string
  readonly occurredAt?: Date | string
}

/**
 * Report that one of the runtime's own background loops failed.
 *
 * The loops retry, so these repeat: an outbox that cannot claim reports on every pass. That is the
 * signal — one of these is noise, a hundred is an outage — so nothing here deduplicates. The
 * `notificationId` keys on the task, its subject, and the moment, which is what a handler needs to
 * collapse a retry storm on its own terms rather than on ours.
 */
export function reportBackgroundTaskFailure(
  host: unknown,
  error: unknown,
  input: ReportBackgroundTaskFailureInput
): void {
  const reporter = asHost(host)?.[ERROR_REPORTER]
  if (!reporter) return

  const occurredAt = resolveOccurredAt(input.occurredAt)
  const subject = input.subject ? `:${input.subject}` : ""
  reporter.report(error, {
    type: "background.task.failed",
    notificationId: `project:${input.projectId}:background:${input.task}${subject}:failed:${occurredAt}`,
    projectId: input.projectId,
    occurredAt,
    task: input.task,
    ...(input.subject === undefined ? {} : { subject: input.subject }),
  })
}

export async function flushSixbErrors(host: unknown, timeoutMs?: number): Promise<void> {
  await asHost(host)?.[ERROR_REPORTER]?.flush(timeoutMs)
}
