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
  matchRuleEvents,
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
  test("buildRuleDependencyIndex indexes object and link dependencies", () => {
    const index = buildRuleDependencyIndex([postedRule, requiresDocumentRule])

    expect(index.objectMutations.get("transaction")?.map((candidate) => candidate.id)).toEqual([
      "transaction.posted",
      "transaction.requires-document",
    ])
    expect(
      index.linkMutations.get("transaction:document")?.map((candidate) => candidate.id)
    ).toEqual(["transaction.requires-document"])
    expect(index.linkDeletes.get("transaction:document")?.map((candidate) => candidate.id)).toEqual(
      ["transaction.requires-document"]
    )
  })

  test("object update matches subject-object rules", () => {
    const index = buildRuleDependencyIndex([postedRule])
    const [candidate] = matchRuleEvent({
      index,
      event: objectUpdatedEvent("transaction", "tx-1"),
    })

    expect(candidate?.rule.id).toBe("transaction.posted")
    expect(candidate?.subject).toEqual({
      kind: "object",
      objectTypeId: "transaction",
      primaryId: "tx-1",
    })
  })

  test("link create matches rules that reference that subject link", () => {
    const index = buildRuleDependencyIndex([requiresDocumentRule, requiresReceiptRule])
    const candidates = matchRuleEvent({
      index,
      event: linkCreatedEvent("transaction", "tx-1", "document"),
    })

    expect(candidates.map((candidate) => candidate.rule.id)).toEqual([
      "transaction.requires-document",
    ])
    expect(candidates[0]?.subject).toEqual({
      kind: "object",
      objectTypeId: "transaction",
      primaryId: "tx-1",
    })
  })

  test("link deleted matches rules that reference that subject link", () => {
    const index = buildRuleDependencyIndex([requiresDocumentRule, requiresReceiptRule])
    const candidates = matchRuleEvent({
      index,
      event: linkDeletedEvent("transaction", "tx-1", "document"),
    })

    expect(candidates.map((candidate) => candidate.rule.id)).toEqual([
      "transaction.requires-document",
    ])
    expect(candidates[0]?.subject).toEqual({
      kind: "object",
      objectTypeId: "transaction",
      primaryId: "tx-1",
    })
  })

  test("unmatched object and link events do not evaluate rules", () => {
    const index = buildRuleDependencyIndex([requiresDocumentRule])

    expect(
      matchRuleEvent({
        index,
        event: objectUpdatedEvent("document", "doc-1"),
      })
    ).toEqual([])
    expect(
      matchRuleEvent({
        index,
        event: linkCreatedEvent("transaction", "tx-1", "receipt"),
      })
    ).toEqual([])
    expect(
      matchRuleEvent({
        index,
        event: linkDeletedEvent("document", "doc-1", "transaction"),
      })
    ).toEqual([])
  })

  test("duplicate rule and subject pairs in one event batch are evaluated once", () => {
    const index = buildRuleDependencyIndex([requiresDocumentRule])
    const candidates = matchRuleEvents({
      index,
      events: [
        objectUpdatedEvent("transaction", "tx-1", "1"),
        linkCreatedEvent("transaction", "tx-1", "document", "2"),
        linkDeletedEvent("transaction", "tx-1", "document", "3"),
      ],
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.rule.id).toBe("transaction.requires-document")
    expect(candidates[0]?.subject).toEqual({
      kind: "object",
      objectTypeId: "transaction",
      primaryId: "tx-1",
    })
  })
})

describe("rule subject evaluation", () => {
  test("new matching object emits rule.triggered", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1", { status: "posted" })

    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt,
    })

    expect(result).toEqual({
      ruleId: "transaction.posted",
      subject: subject("tx-1"),
      matched: true,
      emitted: "triggered",
    })
    expect(await ruleEventTypes(runtime)).toEqual(["rule.triggered"])
    await expect(
      runtime.storage.rules!.getActive({
        projectId: runtime.projectId,
        ruleId: "transaction.posted",
        subject: subject("tx-1"),
      })
    ).resolves.toMatchObject({ triggeredAt: evaluatedAt })
  })

  test("still-matching active object emits no duplicate event", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1", { status: "posted" })

    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt,
    })

    await seedObject(runtime, "tx-1", { status: "posted" })
    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt: "2026-05-07T10:31:00.000Z",
    })

    expect(result.emitted).toBeNull()
    expect(await ruleEventTypes(runtime)).toEqual(["rule.triggered"])
  })

  test("previously active object that no longer matches emits rule.resolved", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1", { status: "posted" })
    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt,
    })

    await seedObject(runtime, "tx-1", { status: "draft" })
    const result = await evaluateRuleForSubject({
      runtime,
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
    await expect(
      runtime.storage.rules!.getActive({
        projectId: runtime.projectId,
        ruleId: "transaction.posted",
        subject: subject("tx-1"),
      })
    ).resolves.toBeNull()
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

  test("violating again after resolution emits rule.triggered again", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1", { status: "posted" })
    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt,
    })

    await seedObject(runtime, "tx-1", { status: "draft" })
    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt: "2026-05-07T10:31:00.000Z",
    })

    await seedObject(runtime, "tx-1", { status: "posted" })
    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt: "2026-05-07T10:32:00.000Z",
    })

    expect(result.emitted).toBe("triggered")
    expect(await ruleEventTypes(runtime)).toEqual([
      "rule.triggered",
      "rule.resolved",
      "rule.triggered",
    ])
  })

  test("a delayed object event evaluates the latest committed object state", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1", { status: "draft" })

    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      evaluatedAt,
    })

    expect(result.matched).toBe(false)
    expect(result.emitted).toBeNull()
  })

  test("a delayed link-delete event evaluates the latest committed link state", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1")
    await seedLink(runtime, "tx-1", "document")

    const result = await evaluateRuleForSubject({
      runtime,
      rule: hasDocumentRule,
      subject: subject("tx-1"),
      evaluatedAt,
    })

    expect(result.matched).toBe(true)
    expect(result.emitted).toBe("triggered")
  })

  test("link-missing rule works for transaction without a document", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1")

    const result = await evaluateRuleForSubject({
      runtime,
      rule: requiresDocumentRule,
      subject: subject("tx-1"),
      evaluatedAt,
    })

    expect(result.matched).toBe(true)
    expect(result.emitted).toBe("triggered")
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

  test("evaluateRuleEvents dedupes and evaluates one rule subject once per batch", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1")
    const index = buildRuleDependencyIndex([requiresDocumentRule])
    const result = await evaluateRuleEvents({
      runtime,
      rules: [requiresDocumentRule],
      index,
      events: [
        objectUpdatedEvent("transaction", "tx-1", "1"),
        linkDeletedEvent("transaction", "tx-1", "document", "2"),
      ],
      evaluatedAt,
    })

    expect(result.evaluations).toHaveLength(1)
    expect(result.evaluations[0]?.emitted).toBe("triggered")
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
    origin: { kind: "runtime" as const, requestId: `request-${cursor}` },
    commitId: `commit-${cursor}`,
    commitOrdinal: 0,
  }
}
