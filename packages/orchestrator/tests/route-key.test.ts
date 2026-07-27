import { describe, expect, test } from "bun:test"
import type { StoredDomainEvent } from "@sixb/core/internal/events"
import { routeKeyForEvent, routeKeysForEvent } from "../src/route-key"

function makeScheduleTriggeredEvent(scheduleId: string): StoredDomainEvent {
  return {
    id: "evt-1",
    schemaVersion: 1,
    projectId: "test-project",
    occurredAt: "2026-04-18T02:00:00.000Z",
    ...materializationCorrelation("evt-2"),
    type: "schedule.triggered",
    topic: "schedules",
    partitionKey: scheduleId,
    payload: {
      scheduleId,
      occurrenceAt: "2026-04-18T02:00:00.000Z",
      triggeredAt: "2026-04-18T02:00:00.000Z",
      occurrenceKey: `${scheduleId}:2026-04-18T02:00:00.000Z`,
    },
    cursor: "1",
  }
}

function makeObjectCreatedEvent(): StoredDomainEvent {
  return {
    id: "evt-2",
    schemaVersion: 1,
    projectId: "test-project",
    occurredAt: "2026-04-18T02:00:00.000Z",
    ...materializationCorrelation("evt-2"),
    type: "object.created",
    topic: "objects",
    partitionKey: "obj-1",
    payload: {
      objectTypeId: "Room",
      primaryId: "room-1",
      properties: { name: "Room A" },
      propertyChanges: { name: { operation: "created", after: "Room A" } },
    },
    cursor: "2",
  }
}

describe("routeKeyForEvent", () => {
  test("schedule.triggered returns schedule.triggered:<scheduleId>", () => {
    const event = makeScheduleTriggeredEvent("nightly-orders")
    expect(routeKeyForEvent(event)).toBe("schedule.triggered:nightly-orders")
  })

  test("other event types return null", () => {
    const event = makeObjectCreatedEvent()
    expect(routeKeyForEvent(event)).toBeNull()
  })

  test("schedule.triggered with different scheduleId returns correct key", () => {
    const event = makeScheduleTriggeredEvent("hourly-sync")
    expect(routeKeyForEvent(event)).toBe("schedule.triggered:hourly-sync")
  })

  test("dataset.version.committed returns dataset.version.committed:<datasetId>", () => {
    const event: StoredDomainEvent = {
      id: "evt-5",
      schemaVersion: 1,
      projectId: "test-project",
      occurredAt: "2026-04-18T02:00:00.000Z",
      type: "dataset.version.committed",
      topic: "datasets",
      partitionKey: "raw.erp.orders",
      payload: {
        datasetId: "raw.erp.orders",
        versionId: "v-1",
        producer: { kind: "sync", id: "sync-orders", runId: "run-1" },
      },
      cursor: "5",
    }
    expect(routeKeyForEvent(event)).toBe("dataset.version.committed:raw.erp.orders")
  })
})

describe("routeKeysForEvent", () => {
  test("adds an object-type scoped event schedule key", () => {
    const event: StoredDomainEvent = {
      id: "evt-object",
      schemaVersion: 1,
      projectId: "test-project",
      occurredAt: "2026-04-18T02:00:00.000Z",
      ...materializationCorrelation("evt-object"),
      type: "object.updated",
      topic: "objects",
      partitionKey: "Invoice:inv-1",
      payload: {
        objectTypeId: "Invoice",
        primaryId: "inv-1",
        properties: { amount: 700 },
        propertyChanges: {
          amount: { operation: "updated", before: 400, after: 700 },
        },
      },
      cursor: "6",
    }

    expect(routeKeysForEvent(event)).toEqual(["event-schedule:object.updated:Invoice"])
  })

  test("adds link, rule, and action scoped event schedule keys", () => {
    const base = {
      schemaVersion: 1 as const,
      projectId: "test-project",
      occurredAt: "2026-04-18T02:00:00.000Z",
    }
    const linkEvent: StoredDomainEvent = {
      ...base,
      id: "evt-link",
      ...materializationCorrelation("evt-link"),
      type: "link.created",
      topic: "links",
      partitionKey: "Invoice:inv-1:payments",
      payload: {
        sourceTypeId: "Invoice",
        sourceId: "inv-1",
        linkId: "payments",
        targetTypeId: "Payment",
        targetId: "pay-1",
        properties: {},
        propertyChanges: {},
      },
      cursor: "7",
    }
    const ruleEvent: StoredDomainEvent = {
      ...base,
      id: "evt-rule",
      type: "rule.triggered",
      topic: "rules",
      partitionKey: "invoice.at-risk:Invoice:inv-1",
      payload: {
        ruleId: "invoice.at-risk",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-1" },
        triggeredAt: base.occurredAt,
      },
      cursor: "8",
    }
    const actionEvent: StoredDomainEvent = {
      ...base,
      id: "evt-action",
      type: "action.completed",
      topic: "actions",
      partitionKey: "approve-invoice:run-1",
      payload: {
        actionId: "approve-invoice",
        runId: "run-1",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-1" },
        finishedAt: base.occurredAt,
      },
      cursor: "9",
    }

    expect(routeKeysForEvent(linkEvent)).toEqual(["event-schedule:link.created:Invoice:payments"])
    expect(routeKeysForEvent(ruleEvent)).toEqual(["event-schedule:rule.triggered:invoice.at-risk"])
    expect(routeKeysForEvent(actionEvent)).toEqual([
      "event-schedule:action.completed:approve-invoice",
    ])
  })
})

function materializationCorrelation(id: string) {
  return {
    origin: { kind: "runtime" as const, requestId: `request-${id}` },
    commitId: `commit-${id}`,
    commitOrdinal: 0,
  }
}
