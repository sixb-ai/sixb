import { describe, expect, test } from "bun:test"
import type { StoredDomainEvent } from "@sixb/core"
import { routeKeyForEvent, routeKeysForEvent } from "../src/route-key"

function makeScheduleTriggeredEvent(scheduleId: string): StoredDomainEvent {
  return {
    id: "evt-1",
    schemaVersion: 1,
    projectId: "test-project",
    occurredAt: "2026-04-18T02:00:00.000Z",
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

function makeObjectUpsertedEvent(): StoredDomainEvent {
  return {
    id: "evt-2",
    schemaVersion: 1,
    projectId: "test-project",
    occurredAt: "2026-04-18T02:00:00.000Z",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "obj-1",
    payload: {
      objectTypeId: "Room",
      primaryId: "room-1",
      properties: { name: "Room A" },
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
    const event = makeObjectUpsertedEvent()
    expect(routeKeyForEvent(event)).toBeNull()
  })

  test("schedule.triggered with different scheduleId returns correct key", () => {
    const event = makeScheduleTriggeredEvent("hourly-sync")
    expect(routeKeyForEvent(event)).toBe("schedule.triggered:hourly-sync")
  })

  test("sync.run.finished returns sync.run.finished:<syncId>:<status>", () => {
    const event: StoredDomainEvent = {
      id: "evt-3",
      schemaVersion: 1,
      projectId: "test-project",
      occurredAt: "2026-04-18T02:00:00.000Z",
      type: "sync.run.finished",
      topic: "syncs",
      partitionKey: "sync-orders:run-1",
      payload: {
        syncId: "sync-orders",
        runId: "run-1",
        status: "succeeded",
      },
      cursor: "3",
    }
    expect(routeKeyForEvent(event)).toBe("sync.run.finished:sync-orders:succeeded")
  })

  test("pipeline.run.finished returns pipeline.run.finished:<pipelineId>:<status>", () => {
    const event: StoredDomainEvent = {
      id: "evt-4",
      schemaVersion: 1,
      projectId: "test-project",
      occurredAt: "2026-04-18T02:00:00.000Z",
      type: "pipeline.run.finished",
      topic: "pipelines",
      partitionKey: "normalize:run-2",
      payload: {
        pipelineId: "normalize",
        runId: "run-2",
        status: "succeeded",
      },
      cursor: "4",
    }
    expect(routeKeyForEvent(event)).toBe("pipeline.run.finished:normalize:succeeded")
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
  test("adds an object-type scoped trigger key", () => {
    const event: StoredDomainEvent = {
      id: "evt-object",
      schemaVersion: 1,
      projectId: "test-project",
      occurredAt: "2026-04-18T02:00:00.000Z",
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

    expect(routeKeysForEvent(event)).toEqual(["trigger:object.updated:Invoice"])
  })

  test("adds link, rule, and action scoped trigger keys", () => {
    const base = {
      schemaVersion: 1 as const,
      projectId: "test-project",
      occurredAt: "2026-04-18T02:00:00.000Z",
    }
    const linkEvent: StoredDomainEvent = {
      ...base,
      id: "evt-link",
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

    expect(routeKeysForEvent(linkEvent)).toEqual(["trigger:link.created:Invoice:payments"])
    expect(routeKeysForEvent(ruleEvent)).toEqual(["trigger:rule.triggered:invoice.at-risk"])
    expect(routeKeysForEvent(actionEvent)).toEqual(["trigger:action.completed:approve-invoice"])
  })
})
