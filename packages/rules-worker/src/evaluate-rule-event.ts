import type {
  ObjectLinkRow,
  ObjectRow,
  RuleDefinition,
  RuleEventSubject,
  RulesStorage,
  StoredDomainEvent,
  StoredRuleResolvedEvent,
  StoredRuleTriggeredEvent,
} from "@sixb/core"
import { deriveRuleEventDependencies } from "@sixb/core"
import { evaluateRulePredicate } from "./evaluate-predicate"
import type {
  EvaluateRuleEventInput,
  EvaluateRuleEventResult,
  EvaluateRuleEventsInput,
  EvaluateRuleForSubjectInput,
  EvaluateRuleForSubjectResult,
  OntologyRuleEvent,
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
    sourceEvents: [input.event],
  }))
}

/**
 * Match an event batch to rule/subject evaluations.
 *
 * Duplicate candidates are merged, not dropped entirely: later evaluation still
 * needs every accepted source event so object/link overlays can reflect the
 * whole batch.
 */
export function matchRuleEvents(input: {
  readonly index: RuleDependencyIndex
  readonly events: readonly OntologyRuleEvent[]
}): readonly RuleEventEvaluationCandidate[] {
  const candidates = new Map<
    string,
    RuleEventEvaluationCandidate & { sourceEvents: OntologyRuleEvent[] }
  >()

  for (const event of input.events) {
    for (const candidate of matchRuleEvent({ index: input.index, event })) {
      const key = evaluationCandidateKey(candidate.rule.id, candidate.subject)
      const existing = candidates.get(key)
      if (existing) {
        // Keep all accepted source events for the later overlay step while
        // still evaluating a given rule/subject only once per event batch.
        existing.sourceEvents.push(event)
      } else {
        candidates.set(key, {
          ...candidate,
          sourceEvents: [event],
        })
      }
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

  for (const candidate of matchRuleEvents({ index: input.index, events: input.events })) {
    evaluations.push(
      await evaluateRuleForSubject({
        runtime: input.runtime,
        rule: candidate.rule,
        subject: candidate.subject,
        sourceEvents: candidate.sourceEvents,
        evaluatedAt,
      })
    )
  }

  return { evaluations }
}

/**
 * Evaluate one rule against one object subject and emit a rule transition only
 * if the durable active-state record changes.
 */
export async function evaluateRuleForSubject(
  input: EvaluateRuleForSubjectInput
): Promise<EvaluateRuleForSubjectResult> {
  const rulesStorage = requireRulesStorage(input.runtime.storage)

  // Object/link projection can lag behind event append. Each evaluation starts
  // from projected storage, then overlays the accepted source events so the
  // predicate sees the same state regardless of projection timing.
  const object = await loadSubjectObjectWithOverlay(input)
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

  const links = await loadLinksWithOverlay(input)
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

async function loadSubjectObjectWithOverlay(
  input: EvaluateRuleForSubjectInput
): Promise<ObjectRow | null> {
  let object = await input.runtime.storage.objects.getByPrimaryId({
    projectId: input.runtime.projectId,
    objectTypeId: input.subject.objectTypeId,
    primaryId: input.subject.primaryId,
  })

  for (const event of input.sourceEvents) {
    if (
      (event.type !== "object.created" &&
        event.type !== "object.updated" &&
        event.type !== "object.deleted") ||
      event.payload.objectTypeId !== input.subject.objectTypeId ||
      event.payload.primaryId !== input.subject.primaryId
    ) {
      continue
    }

    if (event.type === "object.deleted") {
      object = null
      continue
    }

    // An object mutation can either amend the projected row or synthesize it
    // when the evaluator observes the append before object storage projects it.
    const occurredAt = new Date(event.occurredAt)
    object = {
      projectId: input.runtime.projectId,
      objectTypeId: input.subject.objectTypeId,
      primaryId: input.subject.primaryId,
      properties: {
        ...(object?.properties ?? {}),
        ...event.payload.properties,
      },
      createdAt: object?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
      version: (object?.version ?? 0) + 1,
      sourceEventId: event.id,
    }
  }

  return object
}

async function loadLinksWithOverlay(
  input: EvaluateRuleForSubjectInput
): Promise<ReadonlyMap<string, readonly ObjectLinkRow[]>> {
  const linkIds = referencedLinkIds(input.rule)
  const links = new Map<string, ObjectLinkRow[]>()

  await Promise.all(
    linkIds.map(async (linkId) => {
      const rows = await input.runtime.storage.objects.listLinks({
        projectId: input.runtime.projectId,
        objectTypeId: input.subject.objectTypeId,
        objectId: input.subject.primaryId,
        linkId,
      })
      links.set(linkId, [...rows])
    })
  )

  for (const event of input.sourceEvents) {
    if (
      (event.type !== "link.created" &&
        event.type !== "link.updated" &&
        event.type !== "link.deleted") ||
      event.payload.sourceTypeId !== input.subject.objectTypeId ||
      event.payload.sourceId !== input.subject.primaryId ||
      !linkIds.includes(event.payload.linkId)
    ) {
      continue
    }

    const rows = links.get(event.payload.linkId) ?? []
    const rowKey = linkRowKey(
      event.payload.linkId,
      event.payload.targetTypeId,
      event.payload.targetId
    )

    if (event.type === "link.deleted") {
      // Remove only the target edge named by the source event; other outgoing
      // links for the same link id must remain visible to `exists` predicates.
      links.set(
        event.payload.linkId,
        rows.filter((row) => linkRowKey(row.linkId, row.targetTypeId, row.targetId) !== rowKey)
      )
      continue
    }

    // Link mutations replace the matching target edge if it was already
    // projected, otherwise they add the pending edge to the overlaid view.
    const occurredAt = new Date(event.occurredAt)
    const existing = rows.find(
      (row) => linkRowKey(row.linkId, row.targetTypeId, row.targetId) === rowKey
    )
    const next: ObjectLinkRow = {
      projectId: input.runtime.projectId,
      sourceTypeId: event.payload.sourceTypeId,
      sourceId: event.payload.sourceId,
      linkId: event.payload.linkId,
      targetTypeId: event.payload.targetTypeId,
      targetId: event.payload.targetId,
      properties: event.payload.properties,
      createdAt: existing?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
      sourceEventId: event.id,
    }

    links.set(
      event.payload.linkId,
      rows
        .filter((row) => linkRowKey(row.linkId, row.targetTypeId, row.targetId) !== rowKey)
        .concat(next)
    )
  }

  return links
}

function referencedLinkIds(rule: RuleDefinition): readonly string[] {
  const linkIds: string[] = []
  const seen = new Set<string>()

  for (const dependency of deriveRuleEventDependencies(rule)) {
    if (dependency.type === "link.created" && !seen.has(dependency.linkId)) {
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

function linkRowKey(linkId: string, targetTypeId: string, targetId: string): string {
  return JSON.stringify([linkId, targetTypeId, targetId])
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
