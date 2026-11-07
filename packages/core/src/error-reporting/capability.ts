import { SixbErrorReporter } from "./reporter"
import {
  type ReportActionPhaseFailureInput,
  type ReportEventDeliveryFailureInput,
  type ReportMaintenancePassFailureInput,
  type ReportOrchestratorDispatchFailureInput,
  type ReportLakeRetentionFailureInput,
  type ReportRuleEvaluationFailureInput,
  type ReportRunFailureInput,
  type ReportVectorIndexingFailureInput,
  reportActionPhaseFailure as reportActionPhaseFailureWith,
  reportEventDeliveryFailure as reportEventDeliveryFailureWith,
  reportMaintenancePassFailure as reportMaintenancePassFailureWith,
  reportOrchestratorDispatchFailure as reportOrchestratorDispatchFailureWith,
  reportLakeRetentionFailure as reportLakeRetentionFailureWith,
  reportRuleEvaluationFailure as reportRuleEvaluationFailureWith,
  reportRunFailure as reportRunFailureWith,
  reportVectorIndexingFailure as reportVectorIndexingFailureWith,
} from "./reports"
import type { SixbErrorHandler } from "./types"

const ERROR_REPORTER = Symbol("sixb.error-reporter")
const FALLBACK_REPORTER = new SixbErrorReporter()

type ErrorReporterHost = {
  [ERROR_REPORTER]?: SixbErrorReporter
}

function asHost(value: unknown): ErrorReporterHost | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return null
  }
  return value as ErrorReporterHost
}

function resolveSixbErrorReporter(host: unknown): SixbErrorReporter {
  return asHost(host)?.[ERROR_REPORTER] ?? FALLBACK_REPORTER
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

export type {
  ReportActionPhaseFailureInput,
  ReportEventDeliveryFailureInput,
  ReportMaintenancePassFailureInput,
  ReportOrchestratorDispatchFailureInput,
  ReportLakeRetentionFailureInput,
  ReportRuleEvaluationFailureInput,
  ReportRunFailureInput,
  ReportVectorIndexingFailureInput,
}

export function reportActionPhaseFailure(
  host: unknown,
  error: unknown,
  input: ReportActionPhaseFailureInput
): void {
  reportActionPhaseFailureWith(resolveSixbErrorReporter(host), error, input)
}

export function reportRunFailure(
  host: unknown,
  error: unknown,
  input: ReportRunFailureInput
): void {
  reportRunFailureWith(resolveSixbErrorReporter(host), error, input)
}

export function reportEventDeliveryFailure(
  host: unknown,
  error: unknown,
  input: ReportEventDeliveryFailureInput
): void {
  reportEventDeliveryFailureWith(resolveSixbErrorReporter(host), error, input)
}

export function reportMaintenancePassFailure(
  host: unknown,
  error: unknown,
  input: ReportMaintenancePassFailureInput
): void {
  reportMaintenancePassFailureWith(resolveSixbErrorReporter(host), error, input)
}

export function reportOrchestratorDispatchFailure(
  host: unknown,
  error: unknown,
  input: ReportOrchestratorDispatchFailureInput
): void {
  reportOrchestratorDispatchFailureWith(resolveSixbErrorReporter(host), error, input)
}

export function reportRuleEvaluationFailure(
  host: unknown,
  error: unknown,
  input: ReportRuleEvaluationFailureInput
): void {
  reportRuleEvaluationFailureWith(resolveSixbErrorReporter(host), error, input)
}

export async function flushSixbErrors(host: unknown, timeoutMs?: number): Promise<void> {
  await resolveSixbErrorReporter(host).flush(timeoutMs)
}

export function reportVectorIndexingFailure(
  host: object,
  error: unknown,
  input: ReportVectorIndexingFailureInput
): void {
  reportVectorIndexingFailureWith(resolveSixbErrorReporter(host), error, input)
}

export function reportLakeRetentionFailure(
  host: object,
  error: unknown,
  input: ReportLakeRetentionFailureInput
): void {
  reportLakeRetentionFailureWith(resolveSixbErrorReporter(host), error, input)
}
