import type { EventEnvelope } from "../envelope"

export type RuleEventSubject = {
  kind: "object"
  objectTypeId: string
  primaryId: string
}

export interface RuleTriggeredEvent extends EventEnvelope {
  type: "rule.triggered"
  topic: "rules"
  partitionKey: string
  payload: {
    ruleId: string
    subject: RuleEventSubject
    triggeredAt: string
  }
}

export interface RuleResolvedEvent extends EventEnvelope {
  type: "rule.resolved"
  topic: "rules"
  partitionKey: string
  payload: {
    ruleId: string
    subject: RuleEventSubject
    resolvedAt: string
  }
}

export type RuleEvent = RuleTriggeredEvent | RuleResolvedEvent
