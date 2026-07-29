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
}

/** Serializes live evaluations and full reconciliation through one failure-isolated queue. */
export class EvaluationCoordinator {
  private tail: Promise<void> = Promise.resolve()
  private reconciliationQueued = false

  constructor(private readonly options: EvaluationCoordinatorOptions) {}

  enqueueLive(events: readonly OntologyRuleEvent[]): void {
    if (events.length === 0 || this.options.signal.aborted) return
    this.enqueue(
      () =>
        evaluateRuleEvents({
          runtime: this.options.runtime,
          rules: this.options.rules,
          index: this.options.index,
          events,
        }).then(() => undefined),
      { source: "live", eventIds: events.map((event) => event.id) }
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
