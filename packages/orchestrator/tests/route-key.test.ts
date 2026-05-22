import { describe, expect, test } from "bun:test"
import type { StoredDomainEvent } from "@pario/core"
import { routeKeyForEvent } from "../src/route-key"

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
