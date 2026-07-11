import type {
  EventsRuntime,
  ObjectLinkRow,
  ObjectRow,
  RuleDefinition,
  RuleEventSubject,
  RulePredicate,
  Storage,
  StoredLinkCreatedEvent,
  StoredLinkDeletedEvent,
  StoredLinkUpdatedEvent,
  StoredObjectCreatedEvent,
  StoredObjectDeletedEvent,
  StoredObjectUpdatedEvent,
} from "@sixb/core"

export type OntologyRuleEvent =
  | StoredObjectCreatedEvent
  | StoredObjectUpdatedEvent
  | StoredObjectDeletedEvent
  | StoredLinkCreatedEvent
  | StoredLinkUpdatedEvent
  | StoredLinkDeletedEvent

/** Outgoing links for the evaluated subject, grouped by ontology link id. */
export type RuleLinkMap = ReadonlyMap<string, readonly ObjectLinkRow[]>

/**
 * Minimal Sixb runtime shape needed by the live rules worker.
 *
 * The worker intentionally avoids depending on queues, orchestrator routes,
 * lake storage, connectors, or other host-only concerns.
 */
export interface RulesWorkerSixb {
  readonly id: string
  readonly events: EventsRuntime
  readonly storage: Storage
  getRuleDefinitions(): readonly RuleDefinition[]
  getRuleById(ruleId: string): RuleDefinition | null
}

/** Evaluation-only context shared by batch and single-subject helpers. */
export interface RulesWorkerContext {
  readonly projectId: string
  readonly events: EventsRuntime
  readonly storage: Storage
}

/**
 * Payload-level rule index built once at worker startup.
 *
 * EventsRuntime subscriptions filter by event type only today, so this index keeps
 * the live worker from reading storage for rules that cannot be affected by the
 * current object/link event.
 */
export interface RuleDependencyIndex {
  readonly objectMutations: ReadonlyMap<string, readonly RuleDefinition[]>
  readonly linkMutations: ReadonlyMap<string, readonly RuleDefinition[]>
  readonly linkDeletes: ReadonlyMap<string, readonly RuleDefinition[]>
}

/**
 * One deduped evaluation unit for a rule and object subject.
 *
 * `sourceEvents` may contain multiple events from the same event batch.
 * Keeping the full group lets the overlay step evaluate the latest in-batch
 * state while still running the rule only once for the subject.
 */
export interface RuleEventEvaluationCandidate {
  readonly rule: RuleDefinition
  readonly subject: RuleEventSubject
  readonly sourceEvents: readonly OntologyRuleEvent[]
}

export interface EvaluateRulePredicateInput {
  readonly predicate: RulePredicate
  readonly object: ObjectRow
  readonly links: RuleLinkMap
}

export interface EvaluateRuleEventInput {
  readonly runtime: RulesWorkerContext
  readonly rules: readonly RuleDefinition[]
  readonly index: RuleDependencyIndex
  readonly event: OntologyRuleEvent
  readonly evaluatedAt?: string
}

export interface EvaluateRuleEventsInput {
  readonly runtime: RulesWorkerContext
  readonly rules: readonly RuleDefinition[]
  readonly index: RuleDependencyIndex
  readonly events: readonly OntologyRuleEvent[]
  readonly evaluatedAt?: string
}

export interface EvaluateRuleEventResult {
  readonly evaluations: readonly EvaluateRuleForSubjectResult[]
}

export interface EvaluateRuleForSubjectInput {
  readonly runtime: RulesWorkerContext
  readonly rule: RuleDefinition
  readonly subject: RuleEventSubject
  /**
   * Accepted ontology events for this rule/subject. The evaluator overlays
   * these onto projected storage to handle event append before projection.
   */
  readonly sourceEvents: readonly OntologyRuleEvent[]
  readonly evaluatedAt: string
}

export interface EvaluateRuleForSubjectResult {
  readonly ruleId: string
  readonly subject: RuleEventSubject
  readonly matched: boolean
  readonly emitted: "triggered" | "resolved" | null
}
