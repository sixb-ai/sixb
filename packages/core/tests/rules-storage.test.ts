import { describe, expect, test } from "bun:test"
import type { RuleEventSubject, StoredRuleResolvedEvent, StoredRuleTriggeredEvent } from "../src"
import { InMemoryRulesStorage, InMemoryStorage } from "../src"

const defaultSubject: RuleEventSubject = {
  kind: "object",
  objectTypeId: "transaction",
  primaryId: "tx-1",
}

function triggeredEvent(
  overrides: {
    projectId?: string
    ruleId?: string
    subject?: RuleEventSubject
    triggeredAt?: string
    cursor?: string
  } = {}
): StoredRuleTriggeredEvent {
  const projectId = overrides.projectId ?? "project-a"
  const ruleId = overrides.ruleId ?? "transaction.requires-document"
  const subject = overrides.subject ?? defaultSubject
  const cursor = overrides.cursor ?? "1"
  return {
    id: `event-${cursor}`,
    cursor,
    schemaVersion: 1,
    projectId,
    type: "rule.triggered",
    topic: "rules",
    partitionKey: `${ruleId}:${subject.objectTypeId}:${subject.primaryId}`,
    payload: {
      ruleId,
      subject,
      triggeredAt: overrides.triggeredAt ?? "2026-05-07T10:00:00.000Z",
    },
    occurredAt: "2026-05-07T10:00:00.000Z",
  }
}

function resolvedEvent(
  overrides: {
    projectId?: string
    ruleId?: string
    subject?: RuleEventSubject
    resolvedAt?: string
    cursor?: string
  } = {}
): StoredRuleResolvedEvent {
  const projectId = overrides.projectId ?? "project-a"
  const ruleId = overrides.ruleId ?? "transaction.requires-document"
  const subject = overrides.subject ?? defaultSubject
  const cursor = overrides.cursor ?? "2"
  return {
    id: `event-${cursor}`,
    cursor,
    schemaVersion: 1,
    projectId,
    type: "rule.resolved",
    topic: "rules",
    partitionKey: `${ruleId}:${subject.objectTypeId}:${subject.primaryId}`,
    payload: {
      ruleId,
      subject,
      resolvedAt: overrides.resolvedAt ?? "2026-05-07T10:05:00.000Z",
    },
    occurredAt: "2026-05-07T10:05:00.000Z",
  }
}

describe("InMemoryRulesStorage", () => {
  test("getActive returns null before a rule is triggered", async () => {
    const storage = new InMemoryRulesStorage()

    await expect(
      storage.getActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
  })

  test("applyTriggered stores the active rule state", async () => {
    const storage = new InMemoryRulesStorage()
    await storage.applyTriggered(triggeredEvent())

    const active = await storage.getActive({
      projectId: "project-a",
      ruleId: "transaction.requires-document",
      subject: defaultSubject,
    })

    expect(active).toEqual({
      projectId: "project-a",
      ruleId: "transaction.requires-document",
      subject: defaultSubject,
      triggeredAt: "2026-05-07T10:00:00.000Z",
    })
  })

  test("getActive is scoped by project, rule, and subject", async () => {
    const storage = new InMemoryRulesStorage()
    await storage.applyTriggered(triggeredEvent())

    await expect(
      storage.getActive({
        projectId: "project-b",
        ruleId: "transaction.requires-document",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
    await expect(
      storage.getActive({
        projectId: "project-a",
        ruleId: "transaction.amount-positive",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
    await expect(
      storage.getActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
        subject: { ...defaultSubject, primaryId: "tx-2" },
      })
    ).resolves.toBeNull()
  })

  test("listActive returns active states with filters and pagination", async () => {
    const storage = new InMemoryRulesStorage()
    await storage.applyTriggered(
      triggeredEvent({
        triggeredAt: "2026-05-07T10:00:00.000Z",
        cursor: "1",
      })
    )
    await storage.applyTriggered(
      triggeredEvent({
        ruleId: "transaction.amount-positive",
        subject: { ...defaultSubject, primaryId: "tx-2" },
        triggeredAt: "2026-05-07T10:02:00.000Z",
        cursor: "2",
      })
    )
    await storage.applyTriggered(
      triggeredEvent({
        projectId: "project-b",
        triggeredAt: "2026-05-07T10:03:00.000Z",
        cursor: "3",
      })
    )

    await expect(storage.listActive({ projectId: "project-a", limit: 1 })).resolves.toEqual({
      states: [
        {
          projectId: "project-a",
          ruleId: "transaction.amount-positive",
          subject: { kind: "object", objectTypeId: "transaction", primaryId: "tx-2" },
          triggeredAt: "2026-05-07T10:02:00.000Z",
        },
      ],
      hasMore: true,
      total: 2,
    })

    await expect(
      storage.listActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
      })
    ).resolves.toEqual({
      states: [
        {
          projectId: "project-a",
          ruleId: "transaction.requires-document",
          subject: defaultSubject,
          triggeredAt: "2026-05-07T10:00:00.000Z",
        },
      ],
      hasMore: false,
      total: 1,
    })

    await expect(
      storage.listActive({
        projectId: "project-a",
        objectTypeId: "transaction",
        primaryId: "tx-2",
      })
    ).resolves.toEqual({
      states: [
        {
          projectId: "project-a",
          ruleId: "transaction.amount-positive",
          subject: { kind: "object", objectTypeId: "transaction", primaryId: "tx-2" },
          triggeredAt: "2026-05-07T10:02:00.000Z",
        },
      ],
      hasMore: false,
      total: 1,
    })
  })

  test("applyResolved removes active rule state", async () => {
    const storage = new InMemoryRulesStorage()
    await storage.applyTriggered(triggeredEvent())
    await storage.applyResolved(resolvedEvent())

    await expect(
      storage.getActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
  })

  test("applyResolved is a no-op when no active state exists", async () => {
    const storage = new InMemoryRulesStorage()

    await expect(storage.applyResolved(resolvedEvent())).resolves.toBeUndefined()
  })

  test("returned records cannot mutate stored state", async () => {
    const storage = new InMemoryRulesStorage()
    await storage.applyTriggered(triggeredEvent())

    const active = await storage.getActive({
      projectId: "project-a",
      ruleId: "transaction.requires-document",
      subject: defaultSubject,
    })

    expect(active).not.toBeNull()
    const mutable = active as { subject: { primaryId: string } }
    mutable.subject.primaryId = "mutated"

    const reloaded = await storage.getActive({
      projectId: "project-a",
      ruleId: "transaction.requires-document",
      subject: defaultSubject,
    })

    expect(reloaded?.subject.primaryId).toBe("tx-1")
  })
})

describe("InMemoryStorage", () => {
  test("includes rules storage", () => {
    const storage = new InMemoryStorage()

    expect(storage.rules).toBeInstanceOf(InMemoryRulesStorage)
  })
})
