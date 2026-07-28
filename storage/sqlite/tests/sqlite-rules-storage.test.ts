import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { RuleEventSubject } from "@sixb/core"
import type { StoredRuleResolvedEvent, StoredRuleTriggeredEvent } from "@sixb/core/internal/events"
import { SqliteStorage } from "../src"
import { SqliteRulesStorage } from "../src/rules-storage"

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

describe("SqliteRulesStorage", () => {
  let storage: SqliteRulesStorage

  beforeEach(() => {
    storage = new SqliteRulesStorage()
  })

  afterEach(() => {
    storage.close()
  })

  test("getActive returns null before a rule is triggered", async () => {
    await expect(
      storage.getActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
  })

  test("applyTriggered stores the active rule state", async () => {
    await storage.applyTriggered(triggeredEvent())

    await expect(
      storage.getActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
        subject: defaultSubject,
      })
    ).resolves.toEqual({
      projectId: "project-a",
      ruleId: "transaction.requires-document",
      subject: defaultSubject,
      triggeredAt: "2026-05-07T10:00:00.000Z",
    })
  })

  test("applyTriggered updates an existing active state", async () => {
    await storage.applyTriggered(triggeredEvent())
    await storage.applyTriggered(
      triggeredEvent({ triggeredAt: "2026-05-07T10:01:00.000Z", cursor: "2" })
    )

    const active = await storage.getActive({
      projectId: "project-a",
      ruleId: "transaction.requires-document",
      subject: defaultSubject,
    })

    expect(active?.triggeredAt).toBe("2026-05-07T10:01:00.000Z")
  })

  test("getActive is scoped by project, rule, and subject", async () => {
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

  test("listActive filters by visible object type ids before pagination", async () => {
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
        ruleId: "invoice.requires-approval",
        subject: { kind: "object", objectTypeId: "invoice", primaryId: "inv-1" },
        triggeredAt: "2026-05-07T10:04:00.000Z",
        cursor: "3",
      })
    )

    await expect(
      storage.listActive({ projectId: "project-a", objectTypeIds: ["transaction"], limit: 1 })
    ).resolves.toEqual({
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
      storage.listActive({ projectId: "project-a", objectTypeIds: [] })
    ).resolves.toEqual({
      states: [],
      hasMore: false,
      total: 0,
    })
  })

  test("applyResolved removes active rule state", async () => {
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
    await expect(storage.applyResolved(resolvedEvent())).resolves.toBeUndefined()
  })

  test("applyTransitions persists one reconciliation page as a batch", async () => {
    const tx2 = { kind: "object" as const, objectTypeId: "transaction", primaryId: "tx-2" }
    await storage.applyTriggered(triggeredEvent())

    await storage.applyTransitions([resolvedEvent(), triggeredEvent({ subject: tx2, cursor: "3" })])

    const active = await storage.listActive({ projectId: "project-a", order: "asc" })
    expect(active.states.map((state) => state.subject.primaryId)).toEqual(["tx-2"])
  })

  test("batch reads and reconciliation pages preserve stable identity order", async () => {
    const tx2 = { kind: "object" as const, objectTypeId: "transaction", primaryId: "tx-2" }
    const otherRule = "transaction.other"
    await storage.applyTriggered(triggeredEvent({ subject: tx2, cursor: "2" }))
    await storage.applyTriggered(triggeredEvent({ subject: defaultSubject, cursor: "1" }))
    await storage.applyTriggered(
      triggeredEvent({ ruleId: otherRule, subject: defaultSubject, cursor: "3" })
    )

    const active = await storage.getActiveBatch({
      projectId: "project-a",
      items: [
        { ruleId: "transaction.requires-document", subject: tx2 },
        { ruleId: "missing", subject: defaultSubject },
      ],
    })
    const first = await storage.listReconciliationPage({ projectId: "project-a", limit: 2 })
    const second = await storage.listReconciliationPage({
      projectId: "project-a",
      after: first.next,
      limit: 2,
    })

    expect(active.map((state) => state.subject.primaryId)).toEqual(["tx-2"])
    expect(first.states.map((state) => [state.ruleId, state.subject.primaryId])).toEqual([
      [otherRule, "tx-1"],
      ["transaction.requires-document", "tx-1"],
    ])
    expect(second.states.map((state) => state.subject.primaryId)).toEqual(["tx-2"])
  })
})

describe("SqliteStorage", () => {
  test("includes rules storage", () => {
    const storage = new SqliteStorage()

    expect(storage.rules).toBeInstanceOf(SqliteRulesStorage)

    storage.objects.close()
    storage.auth.close()
    storage.actionRuns.close()
    storage.pipelineRuns.close()
    storage.projectionRuns.close()
    storage.workflowRuns.close()
    storage.syncRuns.close()
    storage.timeseries.close()
    storage.webhookDeliveries.close()
    storage.webhookRuns.close()
    storage.rules.close()
  })
})
