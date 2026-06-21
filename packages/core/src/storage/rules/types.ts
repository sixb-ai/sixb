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

export interface RulesStorage {
  getActive(params: {
    projectId: string
    ruleId: string
    subject: RuleEventSubject
  }): Promise<RuleStateRecord | null>

  listActive(params: ListActiveRuleStatesInput): Promise<ListActiveRuleStatesResult>

  applyTriggered(event: StoredRuleTriggeredEvent): Promise<void>

  applyResolved(event: StoredRuleResolvedEvent): Promise<void>
}
