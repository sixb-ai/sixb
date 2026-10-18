import { describe, expect, test } from "bun:test"
import type { JsonValue, RuleDefinition, Storage } from "@sixb/core"
import {
  defineObjectType,
  InMemoryBroker,
  InMemoryStorage,
  link,
  OntologyRegistry,
  prop,
} from "@sixb/core"
import type {
  StoredLinkCreatedEvent,
  StoredLinkDeletedEvent,
  StoredObjectUpdatedEvent,
} from "@sixb/core/internal/events"
import { DomainEventService } from "@sixb/core/internal/events"
import { createMaterializerTestFixture, type MaterializerTestFixture } from "@sixb/core/testing"
import {
  buildRuleDependencyIndex,
  evaluateRuleEvents,
  evaluateRuleForSubject,
  matchRuleEvent,
} from "../src/evaluate-rule-event"

const postedRule = rule("transaction.posted", {
  kind: "property",
  propertyId: "status",
  op: "eq",
  value: "posted",
})

const requiresDocumentRule = rule("transaction.requires-document", {
  kind: "link",
  linkId: "document",
  op: "isMissing",
})

const hasDocumentRule = rule("transaction.has-document", {
  kind: "link",
  linkId: "document",
  op: "exists",
})

const requiresReceiptRule = rule("transaction.requires-receipt", {
  kind: "link",
  linkId: "receipt",
  op: "exists",
})

const compositeRule = rule("transaction.composite-review", {
  kind: "all",
  predicates: [
    { kind: "property", propertyId: "status", op: "eq", value: "posted" },
    {
      kind: "any",
      predicates: [
        { kind: "not", predicate: { kind: "link", linkId: "document", op: "exists" } },
        { kind: "link", linkId: "receipt", op: "exists" },
      ],
    },
    {
      kind: "not",
      predicate: { kind: "property", propertyId: "amount", op: "lt", value: 0 },
    },
  ],
})

const evaluatedAt = "2026-05-07T10:30:00.000Z"

const Document = defineObjectType({
  id: "document",
  name: "Document",
  properties: [prop("id", "string", { primary: true, required: true })],
})
const Transaction = defineObjectType({
  id: "transaction",
  name: "Transaction",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("status", "string"),
    prop("amount", "double"),
  ],
  links: [link("document", Document), link("receipt", Document)],
})
const ontology = new OntologyRegistry({ sources: [Transaction, Document] })
const fixturesByStorage = new WeakMap<Storage, MaterializerTestFixture>()

describe("rule event matching", () => {
  const index = buildRuleDependencyIndex([postedRule, requiresDocumentRule, requiresReceiptRule])

  test.each([
    {
      name: "an object update wakes every rule on its type",
      event: objectUpdatedEvent("transaction", "tx-1"),
      ruleIds: [postedRule.id, requiresDocumentRule.id, requiresReceiptRule.id],
    },
    {
      name: "a link create wakes the rules that reference that link",
      event: linkCreatedEvent("transaction", "tx-1", "document"),
      ruleIds: [requiresDocumentRule.id],
    },
    {
      name: "a link delete wakes the rules that reference that link",
      event: linkDeletedEvent("transaction", "tx-1", "document"),
      ruleIds: [requiresDocumentRule.id],
    },
    {
      name: "an object update of another type wakes nothing",
      event: objectUpdatedEvent("document", "doc-1"),
      ruleIds: [],
    },
    {
      name: "a create of an unreferenced link wakes nothing",
      event: linkCreatedEvent("transaction", "tx-1", "attachment"),
      ruleIds: [],
    },
    {
      name: "a delete of another type's link wakes nothing",
      event: linkDeletedEvent("document", "doc-1", "transaction"),
      ruleIds: [],
    },
  ])("$name", ({ event, ruleIds }) => {
    const candidates = matchRuleEvent({ index, event })

    expect(candidates.map((candidate) => candidate.rule.id)).toEqual([...ruleIds])
    for (const candidate of candidates) expect(candidate.subject).toEqual(subject("tx-1"))
  })
})

describe("rule subject evaluation", () => {
  test("emits a transition only when the subject's match changes", async () => {
    const runtime = createRuntime()
    const active = () =>
      runtime.storage.rules!.getActive({
        projectId: runtime.projectId,
        ruleId: postedRule.id,
        subject: subject("tx-1"),
      })
    const steps = [
      { status: "posted", matched: true, emitted: "triggered" },
      { status: "posted", matched: true, emitted: null },
      { status: "draft", matched: false, emitted: "resolved" },
      { status: "posted", matched: true, emitted: "triggered" },
    ] as const
    let triggeredAt: string | undefined

    for (const [index, step] of steps.entries()) {
      const at = `2026-05-07T10:3${index}:00.000Z`
      await seedObject(runtime, "tx-1", { status: step.status })

      expect(
        await evaluateRuleForSubject({
          runtime,
          rule: postedRule,
          subject: subject("tx-1"),
          evaluatedAt: at,
        })
      ).toEqual({
        ruleId: postedRule.id,
        subject: subject("tx-1"),
        matched: step.matched,
        emitted: step.emitted,
      })
      if (step.emitted === "triggered") triggeredAt = at
      if (step.matched) expect(await active()).toMatchObject({ triggeredAt })
      else expect(await active()).toBeNull()
    }

    expect(await ruleEventTypes(runtime)).toEqual([
      "rule.triggered",
      "rule.resolved",
      "rule.triggered",
    ])
  })

  test("previously active deleted object emits rule.resolved", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1", { status: "posted" })
    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt,
    })

    const withoutObject = {
      ...runtime,
      storage: Object.assign(new InMemoryStorage(), { rules: runtime.storage.rules }),
    }
    const result = await evaluateRuleForSubject({
      runtime: withoutObject,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt: "2026-05-07T10:32:00.000Z",
    })

    expect(result).toEqual({
      ruleId: "transaction.posted",
      subject: subject("tx-1"),
      matched: false,
      emitted: "resolved",
    })
    expect(await ruleEventTypes(runtime)).toEqual(["rule.triggered", "rule.resolved"])
  })

  test("delayed events evaluate the latest committed state, not the event", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1", { status: "draft" })
    await seedObject(runtime, "tx-2")
    await seedLink(runtime, "tx-2", "document")
    const rules = [postedRule, hasDocumentRule]

    const result = await evaluateRuleEvents({
      runtime,
      rules,
      index: buildRuleDependencyIndex(rules),
      events: [
        objectUpdatedEvent("transaction", "tx-1", "1", { status: "posted" }),
        linkDeletedEvent("transaction", "tx-2", "document", "2"),
      ],
      evaluatedAt,
    })

    expect(result.evaluations).toEqual([
      { ruleId: postedRule.id, subject: subject("tx-1"), matched: false, emitted: null },
      { ruleId: hasDocumentRule.id, subject: subject("tx-1"), matched: false, emitted: null },
      { ruleId: hasDocumentRule.id, subject: subject("tx-2"), matched: true, emitted: "triggered" },
    ])
  })

  test("event batches dedupe wake-ups while evaluating current composite state", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1", { status: "posted", amount: 100 })
    await seedLink(runtime, "tx-1", "receipt")
    const index = buildRuleDependencyIndex([compositeRule])
    const result = await evaluateRuleEvents({
      runtime,
      rules: [compositeRule],
      index,
      events: [
        objectUpdatedEvent("transaction", "tx-1", "1", { status: "posted", amount: 100 }),
        linkCreatedEvent("transaction", "tx-1", "document", "2", "doc-1"),
        linkCreatedEvent("transaction", "tx-1", "receipt", "3", "doc-2"),
      ],
      evaluatedAt,
    })

    expect(result.evaluations).toHaveLength(1)
    expect(result.evaluations[0]).toMatchObject({
      ruleId: "transaction.composite-review",
      subject: subject("tx-1"),
      matched: true,
      emitted: "triggered",
    })
    expect(await ruleEventTypes(runtime)).toEqual(["rule.triggered"])
  })
})

function rule(id: string, predicate: RuleDefinition["predicate"]): RuleDefinition {
  return {
    kind: "rule",
    id,
    subject: {
      kind: "object",
      objectTypeId: "transaction",
    },
    predicate,
  }
}

function objectUpdatedEvent(
  objectTypeId: string,
  primaryId: string,
  cursor = "1",
  properties: Record<string, JsonValue> = {}
): StoredObjectUpdatedEvent {
  return {
    id: `event-${cursor}`,
    cursor,
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.updated",
    topic: "objects",
    partitionKey: `${objectTypeId}:${primaryId}`,
    payload: {
      objectTypeId,
      primaryId,
      properties,
      propertyChanges: {},
    },
    occurredAt: "2026-05-07T10:00:00.000Z",
    ...materializationCorrelation(cursor),
  }
}

function subject(primaryId: string) {
  return {
    kind: "object" as const,
    objectTypeId: "transaction",
    primaryId,
  }
}

function createRuntime(): {
  readonly projectId: string
  readonly events: DomainEventService
  readonly storage: Storage
} {
  return {
    projectId: "project-a",
    events: new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() }),
    storage: new InMemoryStorage(),
  }
}

async function ruleEventTypes(runtime: {
  readonly projectId: string
  readonly events: DomainEventService
}): Promise<readonly string[]> {
  const events = await runtime.events.read({
    topics: ["rules"],
  })
  return events.map((event) => event.type)
}

function linkCreatedEvent(
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  cursor = "1",
  targetId = "doc-1"
): StoredLinkCreatedEvent {
  return {
    id: `event-${cursor}`,
    cursor,
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.created",
    topic: "links",
    partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
    payload: {
      sourceTypeId,
      sourceId,
      linkId,
      targetTypeId: "document",
      targetId,
      propertyChanges: {},
    },
    occurredAt: "2026-05-07T10:00:00.000Z",
    ...materializationCorrelation(cursor),
  }
}

function linkDeletedEvent(
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  cursor = "1",
  targetId = "doc-1"
): StoredLinkDeletedEvent {
  return {
    id: `event-${cursor}`,
    cursor,
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.deleted",
    topic: "links",
    partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
    payload: {
      sourceTypeId,
      sourceId,
      linkId,
      targetTypeId: "document",
      targetId,
      propertyChanges: {},
    },
    occurredAt: "2026-05-07T10:00:00.000Z",
    ...materializationCorrelation(cursor),
  }
}

async function seedObject(
  runtime: ReturnType<typeof createRuntime>,
  primaryId: string,
  properties: Record<string, JsonValue> = {}
): Promise<void> {
  await materializerFixture(runtime.storage).seed({
    objects: [
      {
        ref: { objectTypeId: "transaction", primaryId },
        properties: { id: primaryId, ...properties },
      },
    ],
  })
}

async function seedLink(
  runtime: ReturnType<typeof createRuntime>,
  sourceId: string,
  linkId: string,
  targetId = "doc-1"
): Promise<void> {
  await materializerFixture(runtime.storage).seed({
    objects: [
      {
        ref: { objectTypeId: "document", primaryId: targetId },
        properties: { id: targetId },
      },
    ],
    links: [
      {
        ref: {
          source: { objectTypeId: "transaction", primaryId: sourceId },
          linkId,
          target: { objectTypeId: "document", primaryId: targetId },
        },
      },
    ],
  })
}

function materializerFixture(storage: Storage): MaterializerTestFixture {
  const existing = fixturesByStorage.get(storage)
  if (existing) return existing
  const fixture = createMaterializerTestFixture({ projectId: "project-a", ontology, storage })
  fixturesByStorage.set(storage, fixture)
  return fixture
}

function materializationCorrelation(cursor: string) {
  return {
    correlationId: `correlation-${cursor}`,
    origin: { kind: "runtime" as const, requestId: `request-${cursor}` },
    executor: { type: "request" as const, requestId: `request-${cursor}` },
    commitId: `commit-${cursor}`,
    commitOrdinal: 0,
  }
}
