import type { RuleDefinition } from "@sixb/core"
import { evaluateRuleEvents } from "./evaluate-rule-event"
import { reconcileRules } from "./reconcile-rules"
import type { OntologyRuleEvent, RuleDependencyIndex, RulesWorkerContext } from "./types"

interface EvaluationCoordinatorOptions {
  readonly runtime: RulesWorkerContext
  readonly rules: readonly RuleDefinition[]
  readonly index: RuleDependencyIndex
  readonly pageSize: number
  readonly signal: AbortSignal
  readonly onError: (error: unknown, failure: RuleEvaluationFailure) => void
}

export interface RuleEvaluationFailure {
  readonly source: "live" | "reconciliation"
  readonly eventIds: readonly string[]
  /**
   * Set when the failure was attributed to one candidate. Absent when a whole batch or pass died
   * before any single rule could be blamed — which is the more serious case, not the vaguer one.
   */
  readonly ruleId?: string
  readonly subject?: { readonly objectTypeId: string; readonly primaryId: string }
}

/** Serializes live evaluations and full reconciliation through one failure-isolated queue. */
export class EvaluationCoordinator {
  private tail: Promise<void> = Promise.resolve()
  private reconciliationQueued = false

  constructor(private readonly options: EvaluationCoordinatorOptions) {}

  enqueueLive(events: readonly OntologyRuleEvent[]): void {
    if (events.length === 0 || this.options.signal.aborted) return
    const eventIds = events.map((event) => event.id)
    this.enqueue(
      async () => {
        const { failures } = await evaluateRuleEvents({
          runtime: this.options.runtime,
          rules: this.options.rules,
          index: this.options.index,
          events,
        })
        // The evaluator isolates candidates, so a batch can succeed overall and still have failed
        // ones. Each is reported on its own, named — the queue's `catch` below only ever sees the
        // failures that took the whole batch down before any candidate could be blamed.
        for (const failure of failures) {
          this.options.onError(failure.error, {
            source: "live",
            eventIds,
            ruleId: failure.ruleId,
            subject: failure.subject,
          })
        }
      },
      { source: "live", eventIds }
    )
  }

  requestReconciliation(): void {
    if (this.reconciliationQueued || this.options.signal.aborted) return
    this.reconciliationQueued = true
    this.enqueue(
      async () => {
        try {
          await reconcileRules({
            runtime: this.options.runtime,
            rules: this.options.rules,
            pageSize: this.options.pageSize,
            signal: this.options.signal,
          })
        } finally {
          this.reconciliationQueued = false
        }
      },
      { source: "reconciliation", eventIds: [] }
    )
  }

  drain(): Promise<void> {
    return this.tail
  }

  private enqueue(run: () => Promise<void>, failure: RuleEvaluationFailure): void {
    this.tail = this.tail.then(run).catch((error) => {
      this.options.onError(error, failure)
    })
  }
}
