import type {
  DomainEventLog,
  RuleDefinition,
  RuleEventSubject,
  RulePredicate,
  Storage,
} from "@sixb/core"
import type {
  StoredLinkCreatedEvent,
  StoredLinkDeletedEvent,
  StoredLinkUpdatedEvent,
  StoredObjectCreatedEvent,
  StoredObjectDeletedEvent,
  StoredObjectUpdatedEvent,
} from "@sixb/core/internal/events"
import type { ObjectLinkRow, ObjectRow } from "@sixb/core/storage"

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
  readonly events: DomainEventLog
  readonly storage: Storage
  listRules(): readonly RuleDefinition[]
  getRuleById(ruleId: string): RuleDefinition | null
}

export interface RulesWorkerOptions {
  /** Delay between reconciliation requests. Defaults to 60 seconds. */
  readonly reconciliationIntervalMs?: number
  /** Stable object/rule-state page size. Defaults to 500. */
  readonly reconciliationPageSize?: number
}

/** Evaluation-only context shared by batch and single-subject helpers. */
export interface RulesWorkerContext {
  readonly projectId: string
  readonly events: DomainEventLog
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

/** One deduped evaluation unit for a rule and object subject. */
export interface RuleEventEvaluationCandidate {
  readonly rule: RuleDefinition
  readonly subject: RuleEventSubject
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

/** One candidate whose evaluation threw. Every other candidate in the batch still evaluates. */
export interface RuleCandidateFailure {
  readonly ruleId: string
  readonly subject: RuleEventSubject
  readonly error: unknown
}

export interface EvaluateRuleEventResult {
  readonly evaluations: readonly EvaluateRuleForSubjectResult[]
  /**
   * Candidates that threw. The evaluator returns them rather than reporting them: `runtime` here is
   * a reduced context with no error reporter attached, so the coordinator — whose `onError` reaches
   * the `Sixb` instance — is what turns these into notifications.
   */
  readonly failures: readonly RuleCandidateFailure[]
}

export interface EvaluateRuleForSubjectInput {
  readonly runtime: RulesWorkerContext
  readonly rule: RuleDefinition
  readonly subject: RuleEventSubject
  readonly evaluatedAt: string
}

export interface EvaluateRuleForSubjectResult {
  readonly ruleId: string
  readonly subject: RuleEventSubject
  readonly matched: boolean
  readonly emitted: "triggered" | "resolved" | null
}
