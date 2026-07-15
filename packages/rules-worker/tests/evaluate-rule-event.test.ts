import { describe, expect, test } from "bun:test"
import type { RuleDefinition, Storage } from "@sixb/core"
import { InMemoryBroker, InMemoryStorage } from "@sixb/core"
import type {
  StoredLinkCreatedEvent,
  StoredLinkDeletedEvent,
  StoredObjectCreatedEvent,
  StoredObjectDeletedEvent,
  StoredObjectUpdatedEvent,
} from "@sixb/core/internal/events"
import { EventsRuntime } from "@sixb/core/internal/events"
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
    expect(candidates[0]?.sourceEvents.map((event) => event.cursor)).toEqual(["1", "2", "3"])
  })
})

describe("rule subject evaluation", () => {
  test("new matching object emits rule.triggered", async () => {
    const runtime = createRuntime()
    const event = objectCreatedEvent("transaction", "tx-1", "1", { status: "posted" })
    await seedObject(runtime, "tx-1", { status: "posted" })

    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [event],
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
    const event = objectCreatedEvent("transaction", "tx-1", "1", { status: "posted" })
    await seedObject(runtime, "tx-1", { status: "posted" })

    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [event],
      evaluatedAt,
    })

    const repeatEvent = objectUpdatedEvent("transaction", "tx-1", "2", { status: "posted" })
    await seedObject(runtime, "tx-1", { status: "posted" }, "2")
    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [repeatEvent],
      evaluatedAt: "2026-05-07T10:31:00.000Z",
    })

    expect(result.emitted).toBeNull()
    expect(await ruleEventTypes(runtime)).toEqual(["rule.triggered"])
  })

  test("previously active object that no longer matches emits rule.resolved", async () => {
    const runtime = createRuntime()
    const event = objectCreatedEvent("transaction", "tx-1", "1", { status: "posted" })
    await seedObject(runtime, "tx-1", { status: "posted" })
    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [event],
      evaluatedAt,
    })

    const resolvingEvent = objectUpdatedEvent("transaction", "tx-1", "2", { status: "draft" })
    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [resolvingEvent],
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
    const event = objectCreatedEvent("transaction", "tx-1", "1", { status: "posted" })
    await seedObject(runtime, "tx-1", { status: "posted" })
    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [event],
      evaluatedAt,
    })

    const deletedEvent = objectDeletedEvent("transaction", "tx-1", "2")
    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [deletedEvent],
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
    const triggerEvent = objectCreatedEvent("transaction", "tx-1", "1", { status: "posted" })
    await seedObject(runtime, "tx-1", { status: "posted" })
    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [triggerEvent],
      evaluatedAt,
    })

    const resolveEvent = objectUpdatedEvent("transaction", "tx-1", "2", { status: "draft" })
    await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [resolveEvent],
      evaluatedAt: "2026-05-07T10:31:00.000Z",
    })

    const retriggerEvent = objectUpdatedEvent("transaction", "tx-1", "3", { status: "posted" })
    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [retriggerEvent],
      evaluatedAt: "2026-05-07T10:32:00.000Z",
    })

    expect(result.emitted).toBe("triggered")
    expect(await ruleEventTypes(runtime)).toEqual([
      "rule.triggered",
      "rule.resolved",
      "rule.triggered",
    ])
  })

  test("object-update overlay evaluates new properties before storage projects the event", async () => {
    const runtime = createRuntime()
    const event = objectUpdatedEvent("transaction", "tx-1", "1", { status: "posted" })

    const result = await evaluateRuleForSubject({
      runtime,
      rule: postedRule,
      subject: subject("tx-1"),
      sourceEvents: [event],
      evaluatedAt,
    })

    expect(result.matched).toBe(true)
    expect(result.emitted).toBe("triggered")
  })

  test("link-create overlay evaluates the new link before storage projects the event", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1")
    const linkEvent = linkCreatedEvent("transaction", "tx-1", "receipt")

    const result = await evaluateRuleForSubject({
      runtime,
      rule: requiresReceiptRule,
      subject: subject("tx-1"),
      sourceEvents: [linkEvent],
      evaluatedAt,
    })

    expect(result.matched).toBe(true)
    expect(result.emitted).toBe("triggered")
  })

  test("link-deleted overlay removes the link before storage projects the event", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1")
    await seedLink(runtime, "tx-1", "document")

    const removeEvent = linkDeletedEvent("transaction", "tx-1", "document")
    const result = await evaluateRuleForSubject({
      runtime,
      rule: requiresDocumentRule,
      subject: subject("tx-1"),
      sourceEvents: [removeEvent],
      evaluatedAt,
    })

    expect(result.matched).toBe(true)
    expect(result.emitted).toBe("triggered")
  })

  test("link-deleted overlay leaves other targets for the same link id visible", async () => {
    const runtime = createRuntime()
    await seedObject(runtime, "tx-1")
    await seedLink(runtime, "tx-1", "document", "1", "doc-1")
    await seedLink(runtime, "tx-1", "document", "2", "doc-2")

    const removeEvent = linkDeletedEvent("transaction", "tx-1", "document", "3", "doc-1")
    const result = await evaluateRuleForSubject({
      runtime,
      rule: hasDocumentRule,
      subject: subject("tx-1"),
      sourceEvents: [removeEvent],
      evaluatedAt,
    })

    expect(result.matched).toBe(true)
    expect(result.emitted).toBe("triggered")
  })

  test("link-missing rule works for transaction without a document", async () => {
    const runtime = createRuntime()
    const event = objectCreatedEvent("transaction", "tx-1")
    await seedObject(runtime, "tx-1")

    const result = await evaluateRuleForSubject({
      runtime,
      rule: requiresDocumentRule,
      subject: subject("tx-1"),
      sourceEvents: [event],
      evaluatedAt,
    })

    expect(result.matched).toBe(true)
    expect(result.emitted).toBe("triggered")
  })

  test("same-batch object overlays use the final property value", async () => {
    const postedRuntime = createRuntime()
    const postedIndex = buildRuleDependencyIndex([postedRule])
    const postedResult = await evaluateRuleEvents({
      runtime: postedRuntime,
      rules: [postedRule],
      index: postedIndex,
      events: [
        objectUpdatedEvent("transaction", "tx-1", "1", { status: "draft" }),
        objectUpdatedEvent("transaction", "tx-1", "2", { status: "posted" }),
      ],
      evaluatedAt,
    })

    expect(postedResult.evaluations).toHaveLength(1)
    expect(postedResult.evaluations[0]?.matched).toBe(true)
    expect(postedResult.evaluations[0]?.emitted).toBe("triggered")

    const draftRuntime = createRuntime()
    const draftResult = await evaluateRuleEvents({
      runtime: draftRuntime,
      rules: [postedRule],
      index: postedIndex,
      events: [
        objectUpdatedEvent("transaction", "tx-1", "1", { status: "posted" }),
        objectUpdatedEvent("transaction", "tx-1", "2", { status: "draft" }),
      ],
      evaluatedAt,
    })

    expect(draftResult.evaluations).toHaveLength(1)
    expect(draftResult.evaluations[0]?.matched).toBe(false)
    expect(draftResult.evaluations[0]?.emitted).toBeNull()
  })

  test("same-batch link overlays use the final edge state", async () => {
    const missingRuntime = createRuntime()
    await seedObject(missingRuntime, "tx-1")
    const index = buildRuleDependencyIndex([hasDocumentRule])
    const missingResult = await evaluateRuleEvents({
      runtime: missingRuntime,
      rules: [hasDocumentRule],
      index,
      events: [
        linkCreatedEvent("transaction", "tx-1", "document", "1", "doc-1"),
        linkDeletedEvent("transaction", "tx-1", "document", "2", "doc-1"),
      ],
      evaluatedAt,
    })

    expect(missingResult.evaluations).toHaveLength(1)
    expect(missingResult.evaluations[0]?.matched).toBe(false)
    expect(missingResult.evaluations[0]?.emitted).toBeNull()

    const existsRuntime = createRuntime()
    await seedObject(existsRuntime, "tx-1")
    const existsResult = await evaluateRuleEvents({
      runtime: existsRuntime,
      rules: [hasDocumentRule],
      index,
      events: [
        linkDeletedEvent("transaction", "tx-1", "document", "1", "doc-1"),
        linkCreatedEvent("transaction", "tx-1", "document", "2", "doc-1"),
      ],
      evaluatedAt,
    })

    expect(existsResult.evaluations).toHaveLength(1)
    expect(existsResult.evaluations[0]?.matched).toBe(true)
    expect(existsResult.evaluations[0]?.emitted).toBe("triggered")
  })

  test("composite rule evaluation handles nested property and link predicates with overlays", async () => {
    const runtime = createRuntime()
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
  properties: Record<string, unknown> = {}
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
  }
}

function objectCreatedEvent(
  objectTypeId: string,
  primaryId: string,
  cursor = "1",
  properties: Record<string, unknown> = {}
): StoredObjectCreatedEvent {
  return {
    ...objectUpdatedEvent(objectTypeId, primaryId, cursor, properties),
    type: "object.created",
  }
}

function objectDeletedEvent(
  objectTypeId: string,
  primaryId: string,
  cursor = "1"
): StoredObjectDeletedEvent {
  return {
    id: `event-${cursor}`,
    cursor,
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.deleted",
    topic: "objects",
    partitionKey: `${objectTypeId}:${primaryId}`,
    payload: {
      objectTypeId,
      primaryId,
      propertyChanges: {},
    },
    occurredAt: "2026-05-07T10:00:00.000Z",
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
  readonly events: EventsRuntime
  readonly storage: Storage
} {
  return {
    projectId: "project-a",
    events: new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() }),
    storage: new InMemoryStorage(),
  }
}

async function ruleEventTypes(runtime: {
  readonly projectId: string
  readonly events: EventsRuntime
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
  }
}

async function seedObject(
  runtime: ReturnType<typeof createRuntime>,
  primaryId: string,
  properties: Record<string, unknown> = {},
  cursor = "1"
): Promise<void> {
  await runtime.storage.objects.applyObjectUpsert({
    id: `seed-object-${cursor}`,
    cursor: `seed-object-${cursor}`,
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.created",
    topic: "objects",
    partitionKey: `transaction:${primaryId}`,
    payload: {
      objectTypeId: "transaction",
      primaryId,
      properties,
      propertyChanges: {},
    },
    occurredAt: "2026-05-07T10:00:00.000Z",
  })
}

async function seedLink(
  runtime: ReturnType<typeof createRuntime>,
  sourceId: string,
  linkId: string,
  cursor = "1",
  targetId = "doc-1"
): Promise<void> {
  await runtime.storage.objects.applyLinkUpsert({
    id: `seed-link-${cursor}`,
    cursor: `seed-link-${cursor}`,
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.created",
    topic: "links",
    partitionKey: `transaction:${sourceId}:${linkId}`,
    payload: {
      sourceTypeId: "transaction",
      sourceId,
      linkId,
      targetTypeId: "document",
      targetId,
      propertyChanges: {},
    },
    occurredAt: "2026-05-07T10:00:00.000Z",
  })
}
