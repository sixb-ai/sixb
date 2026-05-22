import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { StoredTelemetryAppendedEvent } from "@pario/core"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

describe("PgTimeseriesStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  function createTelemetryEvent(
    projectId: string,
    objectTypeId: string,
    objectId: string,
    propertyId: string,
    value: unknown,
    at: string,
    cursor: string,
    unit?: string
  ): StoredTelemetryAppendedEvent {
    return {
      id: `event-${cursor}`,
      cursor,
      schemaVersion: 1,
      projectId,
      type: "telemetry.appended",
      topic: "telemetry",
      partitionKey: `${objectTypeId}:${objectId}:${propertyId}`,
      payload: { objectTypeId, objectId, propertyId, value, at, unit },
      occurredAt: at,
    }
  }

  test("applyTelemetryAppended stores data point", async () => {
    const now = new Date().toISOString()
    const event = createTelemetryEvent(
      "project-a",
      "Room",
      "room:101",
      "temperature",
      22.5,
      now,
      "1",
      "degreeCelsius"
    )

    await storage.timeseries.applyTelemetryAppended(event)

    const latest = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    expect(latest?.value).toBe(22.5)
    expect(latest?.unit).toBe("degreeCelsius")
    expect(latest?.at.toISOString()).toBe(now)
  })

  test("applyTelemetryAppended is idempotent", async () => {
    const now = new Date().toISOString()
    const event = createTelemetryEvent(
      "project-a",
      "Room",
      "room:101",
      "temperature",
      22.5,
      now,
      "1"
    )

    await storage.timeseries.applyTelemetryAppended(event)
    await storage.timeseries.applyTelemetryAppended(event) // Same event ID

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    expect(history).toHaveLength(1)
  })

  test("getHistory returns chronological data", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")

    for (let i = 0; i < 5; i++) {
      const time = new Date(baseTime.getTime() + i * 60000)
      const event = createTelemetryEvent(
        "project-a",
        "Room",
        "room:101",
        "temperature",
        20 + i,
        time.toISOString(),
        `${i + 1}`
      )
      await storage.timeseries.applyTelemetryAppended(event)
    }

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    expect(history).toHaveLength(5)
    expect(history[0]?.value).toBe(20)
    expect(history[4]?.value).toBe(24)
  })

  test("getHistory with from filter", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")

    for (let i = 0; i < 5; i++) {
      const time = new Date(baseTime.getTime() + i * 60000)
      const event = createTelemetryEvent(
        "project-a",
        "Room",
        "room:101",
        "temperature",
        20 + i,
        time.toISOString(),
        `${i + 1}`
      )
      await storage.timeseries.applyTelemetryAppended(event)
    }

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      from: new Date(baseTime.getTime() + 120000),
    })

    expect(history).toHaveLength(3)
    expect(history[0]?.value).toBe(22)
  })

  test("getHistory with to filter", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")

    for (let i = 0; i < 5; i++) {
      const time = new Date(baseTime.getTime() + i * 60000)
      const event = createTelemetryEvent(
        "project-a",
        "Room",
        "room:101",
        "temperature",
        20 + i,
        time.toISOString(),
        `${i + 1}`
      )
      await storage.timeseries.applyTelemetryAppended(event)
    }

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      to: new Date(baseTime.getTime() + 120000),
    })

    expect(history).toHaveLength(3)
    expect(history[2]?.value).toBe(22)
  })

  test("getHistory with from and to range", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")

    for (let i = 0; i < 5; i++) {
      const time = new Date(baseTime.getTime() + i * 60000)
      const event = createTelemetryEvent(
        "project-a",
        "Room",
        "room:101",
        "temperature",
        20 + i,
        time.toISOString(),
        `${i + 1}`
      )
      await storage.timeseries.applyTelemetryAppended(event)
    }

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      from: new Date(baseTime.getTime() + 60000),
      to: new Date(baseTime.getTime() + 180000),
    })

    expect(history).toHaveLength(3)
    expect(history[0]?.value).toBe(21)
    expect(history[2]?.value).toBe(23)
  })

  test("getHistory with limit", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")

    for (let i = 0; i < 10; i++) {
      const time = new Date(baseTime.getTime() + i * 60000)
      const event = createTelemetryEvent(
        "project-a",
        "Room",
        "room:101",
        "temperature",
        20 + i,
        time.toISOString(),
        `${i + 1}`
      )
      await storage.timeseries.applyTelemetryAppended(event)
    }

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      limit: 3,
    })

    expect(history).toHaveLength(3)
  })

  test("getHistory with desc order", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")

    for (let i = 0; i < 5; i++) {
      const time = new Date(baseTime.getTime() + i * 60000)
      const event = createTelemetryEvent(
        "project-a",
        "Room",
        "room:101",
        "temperature",
        20 + i,
        time.toISOString(),
        `${i + 1}`
      )
      await storage.timeseries.applyTelemetryAppended(event)
    }

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      order: "desc",
    })

    expect(history).toHaveLength(5)
    expect(history[0]?.value).toBe(24) // Most recent first
    expect(history[4]?.value).toBe(20)
  })

  test("getLatest returns most recent value", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")

    // Insert out of chronological order
    const event3 = createTelemetryEvent(
      "project-a",
      "Room",
      "room:101",
      "temperature",
      23,
      new Date(baseTime.getTime() + 120000).toISOString(),
      "3"
    )
    const event1 = createTelemetryEvent(
      "project-a",
      "Room",
      "room:101",
      "temperature",
      21,
      new Date(baseTime.getTime()).toISOString(),
      "1"
    )
    const event2 = createTelemetryEvent(
      "project-a",
      "Room",
      "room:101",
      "temperature",
      22,
      new Date(baseTime.getTime() + 60000).toISOString(),
      "2"
    )

    await storage.timeseries.applyTelemetryAppended(event1)
    await storage.timeseries.applyTelemetryAppended(event3)
    await storage.timeseries.applyTelemetryAppended(event2)

    const latest = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    expect(latest?.value).toBe(23)
  })

  test("getLatest returns null for no data", async () => {
    const latest = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:999",
      propertyId: "temperature",
    })

    expect(latest).toBeNull()
  })

  test("stores different object ids separately", async () => {
    const now = new Date().toISOString()

    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22, now, "1")
    )
    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:102", "temperature", 25, now, "2")
    )

    const latest101 = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    const latest102 = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:102",
      propertyId: "temperature",
    })

    expect(latest101?.value).toBe(22)
    expect(latest102?.value).toBe(25)
  })

  test("stores different properties separately", async () => {
    const now = new Date().toISOString()

    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22, now, "1")
    )
    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "humidity", 50, now, "2")
    )

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    expect(history).toHaveLength(1)
    expect(history[0]?.value).toBe(22)
  })

  test("stores complex values as JSON", async () => {
    const now = new Date().toISOString()
    const complexValue = { x: 10, y: 20, z: 30 }

    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Sensor", "sensor:1", "position", complexValue, now, "1")
    )

    const latest = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Sensor",
      objectId: "sensor:1",
      propertyId: "position",
    })

    expect(latest?.value).toEqual(complexValue)
  })

  test("handles different data types", async () => {
    const now = new Date().toISOString()

    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temp", 22.5, now, "1")
    )
    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "occupied", true, now, "2")
    )
    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "count", 42, now, "3")
    )
    await storage.timeseries.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "label", "Conference", now, "4")
    )

    const temp = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temp",
    })
    const occupied = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "occupied",
    })
    const count = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "count",
    })
    const label = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "label",
    })

    expect(temp?.value).toBe(22.5)
    expect(occupied?.value).toBe(true)
    expect(count?.value).toBe(42)
    expect(label?.value).toBe("Conference")
  })

  test("applyTelemetryAppendedBatch stores multiple points", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")
    const events = Array.from({ length: 5 }, (_, i) => {
      const time = new Date(baseTime.getTime() + i * 60000)
      return createTelemetryEvent(
        "project-a",
        "Room",
        "room:101",
        "temperature",
        20 + i,
        time.toISOString(),
        `${i + 1}`
      )
    })

    await storage.timeseries.applyTelemetryAppendedBatch(events)

    const history = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    expect(history).toHaveLength(5)
    expect(history[0]?.value).toBe(20)
    expect(history[4]?.value).toBe(24)
  })

  test("applyTelemetryAppendedBatch is idempotent", async () => {
    const now = new Date().toISOString()
    const events = [
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22.5, now, "1"),
      createTelemetryEvent("project-a", "Room", "room:101", "humidity", 50, now, "2"),
    ]

    await storage.timeseries.applyTelemetryAppendedBatch(events)
    await storage.timeseries.applyTelemetryAppendedBatch(events) // Replay same batch

    const tempHistory = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })
    const humidHistory = await storage.timeseries.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "humidity",
    })

    expect(tempHistory).toHaveLength(1)
    expect(humidHistory).toHaveLength(1)
  })

  test("applyTelemetryAppendedBatch handles empty array", async () => {
    await storage.timeseries.applyTelemetryAppendedBatch([])
    // Should not throw
  })
})
