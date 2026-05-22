import type { DomainEvent, RuleDefinition, StoredDomainEvent } from "@pario/core"
import { Worker } from "@pario/core"
import { buildRuleDependencyIndex, evaluateRuleEvents } from "./evaluate-rule-event"
import type { OntologyRuleEvent, RuleDependencyIndex, RulesWorkerPario } from "./types"

const ontologyEventTypes = [
  "object.upserted",
  "link.upserted",
  "link.removed",
] as const satisfies readonly DomainEvent["type"][]

/**
 * Live, event-driven rules worker.
 *
 * It subscribes directly to object/link events and evaluates only rules whose
 * dependency index says they can be affected by the event payload.
 */
export class RulesWorker extends Worker {
  private readonly runtime: RulesWorkerPario
  private readonly rules: readonly RuleDefinition[]
  private readonly index: RuleDependencyIndex

  constructor(runtime: RulesWorkerPario) {
    const rules = runtime.getRuleDefinitions()
    if (rules.length === 0) {
      throw new Error("[ParioRulesWorker] Rules workers require at least one registered rule.")
    }

    if (!runtime.storage.rules) {
      throw new Error("[ParioRulesWorker] Rules workers require storage.rules support.")
    }

    super()
    this.runtime = runtime
    this.rules = rules
    // Rules are definitions, not runtime state, so the dependency index can be
    // computed once per worker instance and reused for every event batch.
    this.index = buildRuleDependencyIndex(rules)
  }

  protected async run(signal: AbortSignal): Promise<void> {
    let pending: Promise<void> = Promise.resolve()

    const unsubscribe = await this.runtime.events.subscribe(
      {
        types: ontologyEventTypes,
      },
      (events) => {
        if (signal.aborted) return

        const ontologyEvents = events.filter(isOntologyRuleEvent)
        if (ontologyEvents.length === 0) return

        // The events runtime has no acknowledgement contract yet. Keep local
        // evaluations ordered, log failures, and resume with the next batch.
        pending = pending
          .then(() =>
            evaluateRuleEvents({
              runtime: {
                projectId: this.runtime.id,
                events: this.runtime.events,
                storage: this.runtime.storage,
              },
              rules: this.rules,
              index: this.index,
              events: ontologyEvents,
            })
          )
          .then(() => undefined)
          .catch((error) => {
            console.error("[ParioRulesWorker] Evaluation failed:", error)
          })
      }
    )

    await waitForAbort(signal)

    // Subscribe-and-drain: stop accepting new events first, then finish the
    // evaluations already accepted into the local pending chain.
    unsubscribe()
    await pending
  }
}

// EventsRuntime.subscribe filters by type at runtime, but the public handler type is
// still StoredDomainEvent[]. This guard gives the evaluator the narrower union.
function isOntologyRuleEvent(event: StoredDomainEvent): event is OntologyRuleEvent {
  return (
    event.type === "object.upserted" ||
    event.type === "link.upserted" ||
    event.type === "link.removed"
  )
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }

    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}
