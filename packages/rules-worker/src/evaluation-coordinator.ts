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
  readonly onError: (error: unknown) => void
}

/** Serializes live evaluations and full reconciliation through one failure-isolated queue. */
export class EvaluationCoordinator {
  private tail: Promise<void> = Promise.resolve()
  private reconciliationQueued = false

  constructor(private readonly options: EvaluationCoordinatorOptions) {}

  enqueueLive(events: readonly OntologyRuleEvent[]): void {
    if (events.length === 0 || this.options.signal.aborted) return
    this.enqueue(() =>
      evaluateRuleEvents({
        runtime: this.options.runtime,
        rules: this.options.rules,
        index: this.options.index,
        events,
      }).then(() => undefined)
    )
  }

  requestReconciliation(): void {
    if (this.reconciliationQueued || this.options.signal.aborted) return
    this.reconciliationQueued = true
    this.enqueue(async () => {
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
    })
  }

  drain(): Promise<void> {
    return this.tail
  }

  private enqueue(run: () => Promise<void>): void {
    this.tail = this.tail.then(run).catch((error) => {
      this.options.onError(error)
    })
  }
}
