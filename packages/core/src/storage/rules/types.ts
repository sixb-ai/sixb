import type {
  RuleEventSubject,
  StoredRuleResolvedEvent,
  StoredRuleTriggeredEvent,
} from "../../events"

export interface RuleStateRecord {
  readonly projectId: string
  readonly ruleId: string
  readonly subject: RuleEventSubject
  readonly triggeredAt: string
}

export interface ListActiveRuleStatesInput {
  readonly projectId: string
  readonly ruleId?: string
  readonly objectTypeId?: string
  readonly objectTypeIds?: readonly string[]
  readonly primaryId?: string
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListActiveRuleStatesResult {
  readonly states: readonly RuleStateRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface RuleStateIdentity {
  readonly ruleId: string
  readonly subject: RuleEventSubject
}

export interface RuleStateCursor {
  readonly ruleId: string
  readonly objectTypeId: string
  readonly primaryId: string
}

export interface ListRuleStatesReconciliationPageInput {
  readonly projectId: string
  readonly after?: RuleStateCursor
  readonly limit: number
}

export interface ListRuleStatesReconciliationPageResult {
  readonly states: readonly RuleStateRecord[]
  readonly next?: RuleStateCursor
}

export type RuleStateTransitionEvent = StoredRuleTriggeredEvent | StoredRuleResolvedEvent

export interface RulesStorage {
  getActive(params: {
    projectId: string
    ruleId: string
    subject: RuleEventSubject
  }): Promise<RuleStateRecord | null>

  getActiveBatch(params: {
    projectId: string
    items: readonly RuleStateIdentity[]
  }): Promise<readonly RuleStateRecord[]>

  listActive(params: ListActiveRuleStatesInput): Promise<ListActiveRuleStatesResult>

  /** Stable keyset page used to repair deleted or otherwise missed active subjects. */
  listReconciliationPage(
    params: ListRuleStatesReconciliationPageInput
  ): Promise<ListRuleStatesReconciliationPageResult>

  applyTriggered(event: StoredRuleTriggeredEvent): Promise<void>

  applyResolved(event: StoredRuleResolvedEvent): Promise<void>

  /** Applies one reconciliation page without one provider round trip per transition. */
  applyTransitions(events: readonly RuleStateTransitionEvent[]): Promise<void>
}
