import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { RuleEventSubject } from "@sixb/core"
import type { StoredRuleResolvedEvent, StoredRuleTriggeredEvent } from "@sixb/core/internal/events"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

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

describe("PgRulesStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("getActive returns null before a rule is triggered", async () => {
    await expect(
      storage.rules.getActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
  })

  test("applyTriggered stores the active rule state", async () => {
    await storage.rules.applyTriggered(triggeredEvent())

    await expect(
      storage.rules.getActive({
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
    await storage.rules.applyTriggered(triggeredEvent())
    await storage.rules.applyTriggered(
      triggeredEvent({ triggeredAt: "2026-05-07T10:01:00.000Z", cursor: "2" })
    )

    const active = await storage.rules.getActive({
      projectId: "project-a",
      ruleId: "transaction.requires-document",
      subject: defaultSubject,
    })

    expect(active?.triggeredAt).toBe("2026-05-07T10:01:00.000Z")
  })

  test("getActive is scoped by project, rule, and subject", async () => {
    await storage.rules.applyTriggered(triggeredEvent())

    await expect(
      storage.rules.getActive({
        projectId: "project-b",
        ruleId: "transaction.requires-document",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
    await expect(
      storage.rules.getActive({
        projectId: "project-a",
        ruleId: "transaction.amount-positive",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
    await expect(
      storage.rules.getActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
        subject: { ...defaultSubject, primaryId: "tx-2" },
      })
    ).resolves.toBeNull()
  })

  test("listActive returns active states with filters and pagination", async () => {
    await storage.rules.applyTriggered(
      triggeredEvent({
        triggeredAt: "2026-05-07T10:00:00.000Z",
        cursor: "1",
      })
    )
    await storage.rules.applyTriggered(
      triggeredEvent({
        ruleId: "transaction.amount-positive",
        subject: { ...defaultSubject, primaryId: "tx-2" },
        triggeredAt: "2026-05-07T10:02:00.000Z",
        cursor: "2",
      })
    )
    await storage.rules.applyTriggered(
      triggeredEvent({
        projectId: "project-b",
        triggeredAt: "2026-05-07T10:03:00.000Z",
        cursor: "3",
      })
    )

    await expect(storage.rules.listActive({ projectId: "project-a", limit: 1 })).resolves.toEqual({
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
      storage.rules.listActive({
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
      storage.rules.listActive({
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
    await storage.rules.applyTriggered(
      triggeredEvent({
        triggeredAt: "2026-05-07T10:00:00.000Z",
        cursor: "1",
      })
    )
    await storage.rules.applyTriggered(
      triggeredEvent({
        ruleId: "transaction.amount-positive",
        subject: { ...defaultSubject, primaryId: "tx-2" },
        triggeredAt: "2026-05-07T10:02:00.000Z",
        cursor: "2",
      })
    )
    await storage.rules.applyTriggered(
      triggeredEvent({
        ruleId: "invoice.requires-approval",
        subject: { kind: "object", objectTypeId: "invoice", primaryId: "inv-1" },
        triggeredAt: "2026-05-07T10:04:00.000Z",
        cursor: "3",
      })
    )

    await expect(
      storage.rules.listActive({
        projectId: "project-a",
        objectTypeIds: ["transaction"],
        limit: 1,
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
      hasMore: true,
      total: 2,
    })

    await expect(
      storage.rules.listActive({ projectId: "project-a", objectTypeIds: [] })
    ).resolves.toEqual({
      states: [],
      hasMore: false,
      total: 0,
    })
  })

  test("applyResolved removes active rule state", async () => {
    await storage.rules.applyTriggered(triggeredEvent())
    await storage.rules.applyResolved(resolvedEvent())

    await expect(
      storage.rules.getActive({
        projectId: "project-a",
        ruleId: "transaction.requires-document",
        subject: defaultSubject,
      })
    ).resolves.toBeNull()
  })

  test("applyResolved is a no-op when no active state exists", async () => {
    await expect(storage.rules.applyResolved(resolvedEvent())).resolves.toBeUndefined()
  })
})
