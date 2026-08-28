import type { RuleDefinition, RuleEventSubject } from "@sixb/core"
import type {
  StoredDomainEvent,
  StoredRuleResolvedEvent,
  StoredRuleTriggeredEvent,
} from "@sixb/core/internal/events"
import type {
  LinkBatchKey,
  ObjectBatchKey,
  ObjectLinkRow,
  ObjectRow,
  RuleStateRecord,
  RuleStateTransitionEvent,
  RulesStorage,
} from "@sixb/core/storage"
import { linkBatchKey, objectBatchKey } from "@sixb/core/storage"
import { evaluateRulePredicate } from "./evaluate-predicate"
import { referencedLinkIds } from "./evaluate-rule-event"
import type { RuleLinkMap, RulesWorkerContext } from "./types"

export interface ReconcileRulesInput {
  readonly runtime: RulesWorkerContext
  readonly rules: readonly RuleDefinition[]
  readonly pageSize: number
  readonly signal?: AbortSignal
}

/** Repair rule state from current committed objects, then resolve active states for deleted rows. */
export async function reconcileRules(input: ReconcileRulesInput): Promise<void> {
  const rulesStorage = requireRulesStorage(input.runtime.storage)
  for (const [objectTypeId, rules] of groupRulesByObjectType(input.rules)) {
    await reconcileObjectType(input, rulesStorage, objectTypeId, rules)
    if (input.signal?.aborted) return
  }
  await reconcileDeletedSubjects(input, rulesStorage)
}

async function reconcileObjectType(
  input: ReconcileRulesInput,
  rulesStorage: RulesStorage,
  objectTypeId: string,
  rules: readonly RuleDefinition[]
): Promise<void> {
  let afterPrimaryId: string | undefined
  for (;;) {
    if (input.signal?.aborted) return
    const page = await input.runtime.storage.objects.listByPrimaryIdPage({
      projectId: input.runtime.projectId,
      objectTypeId,
      ...(afterPrimaryId ? { afterPrimaryId } : {}),
      limit: input.pageSize,
    })
    await evaluateObjectPage(input.runtime, rulesStorage, rules, page.objects)
    if (!page.nextPrimaryId) return
    afterPrimaryId = page.nextPrimaryId
  }
}

async function evaluateObjectPage(
  runtime: RulesWorkerContext,
  rulesStorage: RulesStorage,
  rules: readonly RuleDefinition[],
  objects: readonly ObjectRow[]
): Promise<void> {
  if (objects.length === 0) return
  const evaluatedAt = new Date().toISOString()
  const subjects = objects.map(subjectForObject)
  const active = await rulesStorage.getActiveBatch({
    projectId: runtime.projectId,
    items: subjects.flatMap((subject) => rules.map((rule) => ({ ruleId: rule.id, subject }))),
  })
  const activeStates = new Set(active.map((state) => ruleSubjectKey(state.ruleId, state.subject)))
  const links = await loadPageLinks(runtime, rules, objects)
  const transitions: RuleTransition[] = []

  for (const [index, object] of objects.entries()) {
    const subject = subjects[index]
    if (!subject) continue
    for (const rule of rules) {
      const matched = evaluateRulePredicate({
        predicate: rule.predicate,
        object,
        links: links.get(object.primaryId) ?? new Map(),
      })
      const isActive = activeStates.has(ruleSubjectKey(rule.id, subject))
      if (matched && !isActive) {
        transitions.push({ kind: "triggered", rule, subject, evaluatedAt })
      }
      if (!matched && isActive) {
        transitions.push({ kind: "resolved", ruleId: rule.id, subject, evaluatedAt })
      }
    }
  }

  await applyTransitions(runtime, transitions)
}

async function loadPageLinks(
  runtime: RulesWorkerContext,
  rules: readonly RuleDefinition[],
  objects: readonly ObjectRow[]
): Promise<ReadonlyMap<string, RuleLinkMap>> {
  const linkIds = uniqueReferencedLinkIds(rules)
  if (linkIds.length === 0) return new Map()
  const items = objects.flatMap((object) =>
    linkIds.map((linkId) => ({
      objectTypeId: object.objectTypeId,
      objectId: object.primaryId,
      linkId,
    }))
  )
  const rowsByRequest = await runtime.storage.objects.listLinksBatch({
    projectId: runtime.projectId,
    items,
  })
  const linksByObject = new Map<string, Map<string, readonly ObjectLinkRow[]>>()
  for (const object of objects) {
    const links = new Map<string, readonly ObjectLinkRow[]>()
    for (const linkId of linkIds) {
      links.set(
        linkId,
        rowsByRequest.get(linkRequestKey(object.objectTypeId, object.primaryId, linkId)) ?? []
      )
    }
    linksByObject.set(object.primaryId, links)
  }
  return linksByObject
}

async function reconcileDeletedSubjects(
  input: ReconcileRulesInput,
  rulesStorage: RulesStorage
): Promise<void> {
  const rulesById = new Map(input.rules.map((rule) => [rule.id, rule]))
  let after: Parameters<RulesStorage["listReconciliationPage"]>[0]["after"]
  for (;;) {
    if (input.signal?.aborted) return
    const page = await rulesStorage.listReconciliationPage({
      projectId: input.runtime.projectId,
      ...(after ? { after } : {}),
      limit: input.pageSize,
    })
    await resolveMissingSubjects(input.runtime, rulesById, page.states)
    if (!page.next) return
    after = page.next
  }
}

async function resolveMissingSubjects(
  runtime: RulesWorkerContext,
  rulesById: ReadonlyMap<string, RuleDefinition>,
  states: readonly RuleStateRecord[]
): Promise<void> {
  if (states.length === 0) return
  const objects = await runtime.storage.objects.getByPrimaryIdBatch({
    projectId: runtime.projectId,
    items: states.map((state) => ({
      objectTypeId: state.subject.objectTypeId,
      primaryId: state.subject.primaryId,
    })),
  })
  const evaluatedAt = new Date().toISOString()
  const transitions: RuleTransition[] = []
  for (const state of states) {
    const object = objects.get(objectKey(state.subject.objectTypeId, state.subject.primaryId))
    const rule = rulesById.get(state.ruleId)
    const stillOwned = rule?.subject.objectTypeId === state.subject.objectTypeId
    if (object && stillOwned) continue
    transitions.push({
      kind: "resolved",
      ruleId: state.ruleId,
      subject: state.subject,
      evaluatedAt,
    })
  }
  await applyTransitions(runtime, transitions)
}

type RuleTransition =
  | {
      readonly kind: "triggered"
      readonly rule: RuleDefinition
      readonly subject: RuleEventSubject
      readonly evaluatedAt: string
    }
  | {
      readonly kind: "resolved"
      readonly ruleId: string
      readonly subject: RuleEventSubject
      readonly evaluatedAt: string
    }

async function applyTransitions(
  runtime: RulesWorkerContext,
  transitions: readonly RuleTransition[]
): Promise<void> {
  if (transitions.length === 0) return
  const stored = await runtime.events.append({
    events: transitions.map(transitionDraft),
  })
  if (stored.length !== transitions.length) {
    throw new Error("[SixbRulesWorker] Broker returned an incomplete rule transition batch.")
  }

  await runtime.storage.transaction(async (tx) => {
    const transactionalRules = requireRulesStorage(tx)
    await transactionalRules.applyTransitions(stored.map(requireRuleTransitionEvent))
  })
}

function transitionDraft(transition: RuleTransition) {
  if (transition.kind === "triggered") {
    return {
      type: "rule.triggered" as const,
      payload: {
        ruleId: transition.rule.id,
        subject: transition.subject,
        triggeredAt: transition.evaluatedAt,
      },
    }
  }

  return {
    type: "rule.resolved" as const,
    payload: {
      ruleId: transition.ruleId,
      subject: transition.subject,
      resolvedAt: transition.evaluatedAt,
    },
  }
}

function subjectForObject(object: ObjectRow): RuleEventSubject {
  return {
    kind: "object",
    objectTypeId: object.objectTypeId,
    primaryId: object.primaryId,
  }
}

function ruleSubjectKey(ruleId: string, subject: RuleEventSubject): string {
  return JSON.stringify([ruleId, subject.kind, subject.objectTypeId, subject.primaryId])
}

function objectKey(objectTypeId: string, primaryId: string): ObjectBatchKey {
  return objectBatchKey(objectTypeId, primaryId)
}

function linkRequestKey(objectTypeId: string, primaryId: string, linkId: string): LinkBatchKey {
  return linkBatchKey(objectTypeId, primaryId, linkId)
}

function groupRulesByObjectType(
  rules: readonly RuleDefinition[]
): ReadonlyMap<string, readonly RuleDefinition[]> {
  const groups = new Map<string, RuleDefinition[]>()
  for (const rule of rules) {
    const group = groups.get(rule.subject.objectTypeId) ?? []
    group.push(rule)
    groups.set(rule.subject.objectTypeId, group)
  }
  return groups
}

function uniqueReferencedLinkIds(rules: readonly RuleDefinition[]): readonly string[] {
  const ids = new Set<string>()
  for (const rule of rules) {
    for (const linkId of referencedLinkIds(rule)) ids.add(linkId)
  }
  return [...ids]
}

function requireRulesStorage(storage: RulesWorkerContext["storage"]): RulesStorage {
  if (!storage.rules) {
    throw new Error("[SixbRulesWorker] Rules workers require storage.rules support.")
  }
  return storage.rules
}

function requireRuleTransitionEvent(event: StoredDomainEvent): RuleStateTransitionEvent {
  if (event.type === "rule.triggered") return event as StoredRuleTriggeredEvent
  if (event.type === "rule.resolved") return event as StoredRuleResolvedEvent
  throw new Error(`[SixbRulesWorker] Unexpected transition event '${event.type}'.`)
}
