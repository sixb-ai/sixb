import type {
  RuleEventSubject,
  StoredRuleResolvedEvent,
  StoredRuleTriggeredEvent,
} from "../../events"
import type {
  ListActiveRuleStatesInput,
  ListActiveRuleStatesResult,
  RuleStateRecord,
  RulesStorage,
} from "./types"

function stateKey(params: {
  readonly projectId: string
  readonly ruleId: string
  readonly subject: RuleEventSubject
}): string {
  return JSON.stringify([
    params.projectId,
    params.ruleId,
    params.subject.kind,
    params.subject.objectTypeId,
    params.subject.primaryId,
  ])
}

function cloneRuleStateRecord(record: RuleStateRecord): RuleStateRecord {
  return structuredClone(record)
}

function compareRuleStateRecords(
  left: RuleStateRecord,
  right: RuleStateRecord,
  order: "asc" | "desc"
): number {
  const direction = order === "asc" ? 1 : -1
  const fields = [
    left.triggeredAt.localeCompare(right.triggeredAt),
    left.ruleId.localeCompare(right.ruleId),
    left.subject.objectTypeId.localeCompare(right.subject.objectTypeId),
    left.subject.primaryId.localeCompare(right.subject.primaryId),
  ]

  for (const value of fields) {
    if (value !== 0) {
      return value * direction
    }
  }

  return 0
}

export class InMemoryRulesStorage implements RulesStorage {
  private readonly active = new Map<string, RuleStateRecord>()

  snapshot(): InMemoryRulesStorageSnapshot {
    return structuredClone(this.active)
  }

  restore(snapshot: InMemoryRulesStorageSnapshot): void {
    this.active.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.active.set(key, record)
    }
  }

  async getActive(params: {
    projectId: string
    ruleId: string
    subject: RuleEventSubject
  }): Promise<RuleStateRecord | null> {
    const record = this.active.get(stateKey(params))
    return record ? cloneRuleStateRecord(record) : null
  }

  async listActive(input: ListActiveRuleStatesInput): Promise<ListActiveRuleStatesResult> {
    const order = input.order ?? "desc"
    const offset = input.offset ?? 0
    const states = [...this.active.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => !input.ruleId || record.ruleId === input.ruleId)
      .filter((record) => !input.objectTypeId || record.subject.objectTypeId === input.objectTypeId)
      .filter((record) => !input.primaryId || record.subject.primaryId === input.primaryId)
      .sort((left, right) => compareRuleStateRecords(left, right, order))

    const total = states.length
    const windowed =
      input.limit === undefined ? states.slice(offset) : states.slice(offset, offset + input.limit)

    return {
      states: windowed.map(cloneRuleStateRecord),
      hasMore: offset + windowed.length < total,
      total,
    }
  }

  async applyTriggered(event: StoredRuleTriggeredEvent): Promise<void> {
    const record: RuleStateRecord = {
      projectId: event.projectId,
      ruleId: event.payload.ruleId,
      subject: structuredClone(event.payload.subject),
      triggeredAt: event.payload.triggeredAt,
    }

    this.active.set(stateKey(record), cloneRuleStateRecord(record))
  }

  async applyResolved(event: StoredRuleResolvedEvent): Promise<void> {
    this.active.delete(
      stateKey({
        projectId: event.projectId,
        ruleId: event.payload.ruleId,
        subject: event.payload.subject,
      })
    )
  }
}

export type InMemoryRulesStorageSnapshot = Map<string, RuleStateRecord>
