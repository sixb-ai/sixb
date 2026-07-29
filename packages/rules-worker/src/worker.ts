import type { DomainEvent, RuleDefinition } from "@sixb/core"
import { reportRuleEvaluationFailure } from "@sixb/core/internal/error-reporting"
import type { StoredDomainEvent } from "@sixb/core/internal/events"
import { Worker } from "@sixb/core/internal/workers"
import { buildRuleDependencyIndex } from "./evaluate-rule-event"
import { EvaluationCoordinator } from "./evaluation-coordinator"
import type {
  OntologyRuleEvent,
  RuleDependencyIndex,
  RulesWorkerOptions,
  RulesWorkerSixb,
} from "./types"

const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000
const DEFAULT_RECONCILIATION_PAGE_SIZE = 500
const MAX_RECONCILIATION_PAGE_SIZE = 1_000

const ontologyEventTypes = [
  "object.created",
  "object.updated",
  "object.deleted",
  "link.created",
  "link.updated",
  "link.deleted",
] as const satisfies readonly DomainEvent["type"][]

/**
 * Rules worker backed by live wake-up events and periodic current-state reconciliation.
 */
export class RulesWorker extends Worker {
  private readonly runtime: RulesWorkerSixb
  private readonly rules: readonly RuleDefinition[]
  private readonly index: RuleDependencyIndex
  private readonly reconciliationIntervalMs: number
  private readonly reconciliationPageSize: number

  constructor(runtime: RulesWorkerSixb, options: RulesWorkerOptions = {}) {
    const rules = runtime.getRuleDefinitions()
    if (rules.length === 0) {
      throw new Error("[SixbRulesWorker] Rules workers require at least one registered rule.")
    }

    if (!runtime.storage.rules) {
      throw new Error("[SixbRulesWorker] Rules workers require storage.rules support.")
    }

    super()
    this.runtime = runtime
    this.rules = rules
    // Rules are definitions, not runtime state, so the dependency index can be
    // computed once per worker instance and reused for every event batch.
    this.index = buildRuleDependencyIndex(rules)
    this.reconciliationIntervalMs = positiveInteger(
      options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS,
      "reconciliationIntervalMs"
    )
    this.reconciliationPageSize = boundedPositiveInteger(
      options.reconciliationPageSize ?? DEFAULT_RECONCILIATION_PAGE_SIZE,
      "reconciliationPageSize",
      MAX_RECONCILIATION_PAGE_SIZE
    )
  }

  protected async run(signal: AbortSignal): Promise<void> {
    const coordinator = new EvaluationCoordinator({
      runtime: {
        projectId: this.runtime.id,
        events: this.runtime.events,
        storage: this.runtime.storage,
      },
      rules: this.rules,
      index: this.index,
      pageSize: this.reconciliationPageSize,
      signal,
      onError: (error, failure) => {
        console.error("[SixbRulesWorker] Evaluation failed:", error)
        reportRuleEvaluationFailure(this.runtime, error, {
          projectId: this.runtime.id,
          ...failure,
        })
      },
    })

    const unsubscribe = await this.runtime.events.subscribe(
      {
        types: ontologyEventTypes,
      },
      (events) => {
        if (signal.aborted) return

        const ontologyEvents = events.filter(isOntologyRuleEvent)
        if (ontologyEvents.length === 0) return

        coordinator.enqueueLive(ontologyEvents)
      }
    )

    // Subscribe first: events arriving during the initial scan join the same serialized queue and
    // re-read current state after reconciliation.
    coordinator.requestReconciliation()
    await requestPeriodicReconciliation(coordinator, this.reconciliationIntervalMs, signal)

    unsubscribe()
    await coordinator.drain()
  }
}

// EventsRuntime.subscribe filters by type at runtime, but the public handler type is
// still StoredDomainEvent[]. This guard gives the evaluator the narrower union.
function isOntologyRuleEvent(event: StoredDomainEvent): event is OntologyRuleEvent {
  return (
    event.type === "object.created" ||
    event.type === "object.updated" ||
    event.type === "object.deleted" ||
    event.type === "link.created" ||
    event.type === "link.updated" ||
    event.type === "link.deleted"
  )
}

async function requestPeriodicReconciliation(
  coordinator: EvaluationCoordinator,
  intervalMs: number,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    await waitForAbort(intervalMs, signal)
    if (!signal.aborted) coordinator.requestReconciliation()
  }
}

async function waitForAbort(timeoutMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }

    const timer = setTimeout(finish, timeoutMs)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[SixbRulesWorker] ${name} must be a positive safe integer.`)
  }
  return value
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  const valid = positiveInteger(value, name)
  if (valid > maximum) {
    throw new Error(`[SixbRulesWorker] ${name} must not exceed ${maximum}.`)
  }
  return valid
}
