import { SixbErrorReporter } from "./reporter"
import type { SixbErrorHandler, SixbFailedRun } from "./types"

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

  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : (input.occurredAt ?? new Date().toISOString())
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
  readonly occurredAt: string
  readonly attempts: number
  readonly eventIds: readonly string[]
}

export function reportEventDeliveryFailure(
  host: unknown,
  error: unknown,
  input: ReportEventDeliveryFailureInput
): void {
  const reporter = asHost(host)?.[ERROR_REPORTER]
  if (!reporter || input.eventIds.length === 0) return

  const eventIds = [...input.eventIds].sort()
  reporter.report(error, {
    type: "event.delivery.failed",
    notificationId: `project:${input.projectId}:event-delivery:${eventIds[0]}:attempt:${input.attempts}`,
    projectId: input.projectId,
    occurredAt: input.occurredAt,
    attempts: input.attempts,
    eventIds,
  })
}

export interface ReportRuleEvaluationFailureInput {
  readonly projectId: string
  readonly source: "live" | "reconciliation"
  readonly eventIds?: readonly string[]
  readonly occurredAt?: Date | string
}

export function reportRuleEvaluationFailure(
  host: unknown,
  error: unknown,
  input: ReportRuleEvaluationFailureInput
): void {
  const reporter = asHost(host)?.[ERROR_REPORTER]
  if (!reporter) return

  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : (input.occurredAt ?? new Date().toISOString())
  const eventIds = [...(input.eventIds ?? [])].sort()
  const occurrence = eventIds[0] ?? "current-state"
  reporter.report(error, {
    type: "rule.evaluation.failed",
    notificationId: `project:${input.projectId}:rule-evaluation:${input.source}:${occurrence}:failed:${occurredAt}`,
    projectId: input.projectId,
    occurredAt,
    source: input.source,
    eventIds,
  })
}

export async function flushSixbErrors(host: unknown, timeoutMs?: number): Promise<void> {
  await asHost(host)?.[ERROR_REPORTER]?.flush(timeoutMs)
}
