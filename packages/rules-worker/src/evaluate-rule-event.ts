import type { RuleDefinition, RuleEventSubject } from "@sixb/core"
import { deriveRuleEventDependencies } from "@sixb/core"
import type {
  StoredDomainEvent,
  StoredRuleResolvedEvent,
  StoredRuleTriggeredEvent,
} from "@sixb/core/internal/events"
import type { ObjectLinkRow, RulesStorage } from "@sixb/core/storage"
import { evaluateRulePredicate } from "./evaluate-predicate"
import type {
  EvaluateRuleEventInput,
  EvaluateRuleEventResult,
  EvaluateRuleEventsInput,
  EvaluateRuleForSubjectInput,
  EvaluateRuleForSubjectResult,
  OntologyRuleEvent,
  RuleCandidateFailure,
  RuleDependencyIndex,
  RuleEventEvaluationCandidate,
} from "./types"

/** Build the worker's cheap event-payload lookup table from rule dependencies. */
export function buildRuleDependencyIndex(rules: readonly RuleDefinition[]): RuleDependencyIndex {
  const objectMutations = new Map<string, RuleDefinition[]>()
  const linkMutations = new Map<string, RuleDefinition[]>()
  const linkDeletes = new Map<string, RuleDefinition[]>()

  // The events runtime can only filter by type today, so this in-memory index is
  // the cheap payload-level filter before any object storage reads happen.
  for (const rule of rules) {
    for (const dependency of deriveRuleEventDependencies(rule)) {
      switch (dependency.type) {
        case "object.created":
        case "object.updated":
        case "object.deleted":
          addRule(objectMutations, dependency.objectTypeId, rule)
          break
        case "link.created":
        case "link.updated":
          addRule(
            linkMutations,
            linkDependencyKey(dependency.sourceTypeId, dependency.linkId),
            rule
          )
          break
        case "link.deleted":
          addRule(linkDeletes, linkDependencyKey(dependency.sourceTypeId, dependency.linkId), rule)
          break
      }
    }
  }

  return {
    objectMutations,
    linkMutations,
    linkDeletes,
  }
}

export function matchRuleEvent(input: {
  readonly index: RuleDependencyIndex
  readonly event: OntologyRuleEvent
}): readonly RuleEventEvaluationCandidate[] {
  const rules = rulesForEvent(input.index, input.event)
  if (rules.length === 0) return []

  const subject = subjectForEvent(input.event)
  return rules.map((rule) => ({
    rule,
    subject,
  }))
}

/**
 * Match an event batch to rule/subject evaluations.
 *
 * Duplicate candidates are evaluated once against current committed state.
 */
export function matchRuleEvents(input: {
  readonly index: RuleDependencyIndex
  readonly events: readonly OntologyRuleEvent[]
}): readonly RuleEventEvaluationCandidate[] {
  const candidates = new Map<string, RuleEventEvaluationCandidate>()

  for (const event of input.events) {
    for (const candidate of matchRuleEvent({ index: input.index, event })) {
      const key = evaluationCandidateKey(candidate.rule.id, candidate.subject)
      if (!candidates.has(key)) candidates.set(key, candidate)
    }
  }

  return [...candidates.values()]
}

export async function evaluateRuleEvent(
  input: EvaluateRuleEventInput
): Promise<EvaluateRuleEventResult> {
  return evaluateRuleEvents({
    runtime: input.runtime,
    rules: input.rules,
    index: input.index,
    events: [input.event],
    evaluatedAt: input.evaluatedAt,
  })
}

/** Evaluate every deduped rule/subject candidate affected by one event batch. */
export async function evaluateRuleEvents(
  input: EvaluateRuleEventsInput
): Promise<EvaluateRuleEventResult> {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString()
  const evaluations: EvaluateRuleForSubjectResult[] = []
  const failures: RuleCandidateFailure[] = []

  for (const candidate of matchRuleEvents({ index: input.index, events: input.events })) {
    try {
      evaluations.push(
        await evaluateRuleForSubject({
          runtime: input.runtime,
          rule: candidate.rule,
          subject: candidate.subject,
          evaluatedAt,
        })
      )
    } catch (error) {
      // Candidates are independent. One failing rule must not cancel the rest of the batch, and the
      // caller needs the rule and subject to report the failure at all.
      failures.push({ ruleId: candidate.rule.id, subject: candidate.subject, error })
    }
  }

  return { evaluations, failures }
}

/**
 * Evaluate one rule against one object subject and emit a rule transition only
 * if the durable active-state record changes.
 */
export async function evaluateRuleForSubject(
  input: EvaluateRuleForSubjectInput
): Promise<EvaluateRuleForSubjectResult> {
  const rulesStorage = requireRulesStorage(input.runtime.storage)

  // Materializer facts are emitted after the effective state commits. The event wakes the rule;
  // it does not reconstruct historical state. Delayed delivery therefore evaluates current state.
  const object = await input.runtime.storage.objects.getByPrimaryId({
    projectId: input.runtime.projectId,
    objectTypeId: input.subject.objectTypeId,
    primaryId: input.subject.primaryId,
  })
  if (!object) {
    const active = await rulesStorage.getActive({
      projectId: input.runtime.projectId,
      ruleId: input.rule.id,
      subject: input.subject,
    })

    if (active) {
      await appendResolvedRuleEvent({ evaluation: input, rulesStorage })
      return {
        ruleId: input.rule.id,
        subject: input.subject,
        matched: false,
        emitted: "resolved",
      }
    }

    return {
      ruleId: input.rule.id,
      subject: input.subject,
      matched: false,
      emitted: null,
    }
  }

  const links = await loadCurrentLinks(input)
  const matched = evaluateRulePredicate({
    predicate: input.rule.predicate,
    object,
    links,
  })

  // Durable rule state is intentionally tiny: just enough to suppress duplicate
  // triggers and know when a later non-match should emit a resolution.
  const active = await rulesStorage.getActive({
    projectId: input.runtime.projectId,
    ruleId: input.rule.id,
    subject: input.subject,
  })

  if (matched && !active) {
    const [stored] = await input.runtime.events.append({
      events: [
        {
          type: "rule.triggered",
          payload: {
            ruleId: input.rule.id,
            subject: input.subject,
            triggeredAt: input.evaluatedAt,
          },
        },
      ],
    })
    const event = requireRuleTriggeredEvent(stored)
    await rulesStorage.applyTriggered(event)
    return {
      ruleId: input.rule.id,
      subject: input.subject,
      matched,
      emitted: "triggered",
    }
  }

  if (!matched && active) {
    await appendResolvedRuleEvent({ evaluation: input, rulesStorage })
    return {
      ruleId: input.rule.id,
      subject: input.subject,
      matched,
      emitted: "resolved",
    }
  }

  return {
    ruleId: input.rule.id,
    subject: input.subject,
    matched,
    emitted: null,
  }
}

async function appendResolvedRuleEvent(params: {
  readonly evaluation: EvaluateRuleForSubjectInput
  readonly rulesStorage: RulesStorage
}): Promise<void> {
  const [stored] = await params.evaluation.runtime.events.append({
    events: [
      {
        type: "rule.resolved",
        payload: {
          ruleId: params.evaluation.rule.id,
          subject: params.evaluation.subject,
          resolvedAt: params.evaluation.evaluatedAt,
        },
      },
    ],
  })
  const event = requireRuleResolvedEvent(stored)
  await params.rulesStorage.applyResolved(event)
}

function addRule(map: Map<string, RuleDefinition[]>, key: string, rule: RuleDefinition): void {
  const rules = map.get(key)
  if (!rules) {
    map.set(key, [rule])
    return
  }

  if (!rules.some((existing) => existing.id === rule.id)) {
    rules.push(rule)
  }
}

function rulesForEvent(
  index: RuleDependencyIndex,
  event: OntologyRuleEvent
): readonly RuleDefinition[] {
  switch (event.type) {
    case "object.created":
    case "object.updated":
    case "object.deleted":
      return index.objectMutations.get(event.payload.objectTypeId) ?? []
    case "link.created":
    case "link.updated":
      return (
        index.linkMutations.get(
          linkDependencyKey(event.payload.sourceTypeId, event.payload.linkId)
        ) ?? []
      )
    case "link.deleted":
      return (
        index.linkDeletes.get(
          linkDependencyKey(event.payload.sourceTypeId, event.payload.linkId)
        ) ?? []
      )
  }
}

async function loadCurrentLinks(
  input: EvaluateRuleForSubjectInput
): Promise<ReadonlyMap<string, readonly ObjectLinkRow[]>> {
  const linkIds = referencedLinkIds(input.rule)
  const links = new Map<string, readonly ObjectLinkRow[]>()
  const rows = await input.runtime.storage.objects.listLinksBatch({
    projectId: input.runtime.projectId,
    items: linkIds.map((linkId) => ({
      objectTypeId: input.subject.objectTypeId,
      objectId: input.subject.primaryId,
      linkId,
    })),
  })
  for (const linkId of linkIds) {
    links.set(
      linkId,
      rows.get(`${input.subject.objectTypeId}:${input.subject.primaryId}:${linkId}`) ?? []
    )
  }

  return links
}

export function referencedLinkIds(rule: RuleDefinition): readonly string[] {
  const linkIds: string[] = []
  const seen = new Set<string>()

  for (const dependency of deriveRuleEventDependencies(rule)) {
    if (
      (dependency.type === "link.created" ||
        dependency.type === "link.updated" ||
        dependency.type === "link.deleted") &&
      !seen.has(dependency.linkId)
    ) {
      seen.add(dependency.linkId)
      linkIds.push(dependency.linkId)
    }
  }

  return linkIds
}

/** Convert the source domain event into the object subject rules evaluate. */
function subjectForEvent(event: OntologyRuleEvent): RuleEventSubject {
  switch (event.type) {
    case "object.created":
    case "object.updated":
    case "object.deleted":
      return {
        kind: "object",
        objectTypeId: event.payload.objectTypeId,
        primaryId: event.payload.primaryId,
      }
    case "link.created":
    case "link.updated":
    case "link.deleted":
      return {
        kind: "object",
        objectTypeId: event.payload.sourceTypeId,
        primaryId: event.payload.sourceId,
      }
  }
}

function linkDependencyKey(sourceTypeId: string, linkId: string): string {
  return `${sourceTypeId}:${linkId}`
}

function evaluationCandidateKey(ruleId: string, subject: RuleEventSubject): string {
  return JSON.stringify([ruleId, subject.kind, subject.objectTypeId, subject.primaryId])
}

function requireRulesStorage(
  storage: EvaluateRuleForSubjectInput["runtime"]["storage"]
): RulesStorage {
  if (!storage.rules) {
    throw new Error("[SixbRulesWorker] Rules workers require storage.rules support.")
  }

  return storage.rules
}

function requireRuleTriggeredEvent(event: StoredDomainEvent | undefined): StoredRuleTriggeredEvent {
  if (!event || event.type !== "rule.triggered") {
    throw new Error("[SixbRulesWorker] Failed to append rule.triggered event.")
  }

  return event
}

function requireRuleResolvedEvent(event: StoredDomainEvent | undefined): StoredRuleResolvedEvent {
  if (!event || event.type !== "rule.resolved") {
    throw new Error("[SixbRulesWorker] Failed to append rule.resolved event.")
  }

  return event
}
