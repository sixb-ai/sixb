import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { StoredTelemetryAppendedEvent } from "@sixb/core/internal/events"
import { migrateSqliteDatabase } from "../src/migrations"
import { SqliteTimeseriesStorage } from "../src/timeseries-storage"

describe("SqliteTimeseriesStorage", () => {
  let storage: SqliteTimeseriesStorage

  beforeEach(() => {
    storage = new SqliteTimeseriesStorage() // in-memory mode
  })

  afterEach(() => {
    storage.close()
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

    await storage.applyTelemetryAppended(event)

    const latest = await storage.getLatest({
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

    await storage.applyTelemetryAppended(event)
    await storage.applyTelemetryAppended(event) // Same event ID

    const history = await storage.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    expect(history).toHaveLength(1)
  })

  test("overwrites the point at the same instant (last write wins)", async () => {
    const at = new Date("2024-01-01T00:00:00.000Z").toISOString()
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22.5, at, "1")
    )
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 23.5, at, "2")
    )

    const history = await storage.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })
    expect(history).toHaveLength(1)
    expect(history[0]?.value).toBe(23.5)

    const latest = await storage.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })
    expect(latest?.value).toBe(23.5)
    expect(latest?.sourceEventId).toBe("event-2")
  })

  test("applyTelemetryAppendedBatch upserts same-instant points within one batch", async () => {
    const at = new Date("2024-01-01T00:00:00.000Z").toISOString()
    await storage.applyTelemetryAppendedBatch([
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22.5, at, "1"),
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 23.5, at, "2"),
    ])

    const history = await storage.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })
    expect(history).toHaveLength(1)
    expect(history[0]?.value).toBe(23.5)
  })

  test("rejects a non-canonical 'at' timestamp", async () => {
    await expect(
      storage.applyTelemetryAppended(
        createTelemetryEvent(
          "project-a",
          "Room",
          "room:101",
          "temperature",
          1,
          "2024-01-01T00:00:00+05:00", // zone offset, not canonical UTC
          "1"
        )
      )
    ).rejects.toThrow("[SixbSqlite]")

    await expect(
      storage.applyTelemetryAppended(
        createTelemetryEvent(
          "project-a",
          "Room",
          "room:101",
          "temperature",
          1,
          "2024-01-01 00:00:00", // zone-less
          "2"
        )
      )
    ).rejects.toThrow("canonical UTC ISO-8601")
  })

  test("getHistory returns chronological data", async () => {
    const baseTime = new Date("2024-01-01T00:00:00Z")

    for (let i = 0; i < 5; i++) {
      const time = new Date(baseTime.getTime() + i * 60000) // Every minute
      const event = createTelemetryEvent(
        "project-a",
        "Room",
        "room:101",
        "temperature",
        20 + i,
        time.toISOString(),
        `${i + 1}`
      )
      await storage.applyTelemetryAppended(event)
    }

    const history = await storage.getHistory({
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
      await storage.applyTelemetryAppended(event)
    }

    const history = await storage.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      from: new Date(baseTime.getTime() + 120000), // Skip first 2
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
      await storage.applyTelemetryAppended(event)
    }

    const history = await storage.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      to: new Date(baseTime.getTime() + 120000), // Only first 3
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
      await storage.applyTelemetryAppended(event)
    }

    const history = await storage.getHistory({
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
      await storage.applyTelemetryAppended(event)
    }

    const history = await storage.getHistory({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      limit: 3,
    })

    expect(history).toHaveLength(3)
  })

  test("getHistoryBatch returns requested series with per-series limits", async () => {
    const t1 = "2024-01-01T00:00:00.000Z"
    const t2 = "2024-01-01T00:01:00.000Z"

    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 20, t1, "1")
    )
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 21, t2, "2")
    )
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "humidity", 40, t1, "3")
    )

    const batch = await storage.getHistoryBatch({
      projectId: "project-a",
      series: [
        { objectTypeId: "Room", objectId: "room:101", propertyId: "temperature" },
        { objectTypeId: "Room", objectId: "room:101", propertyId: "humidity" },
        { objectTypeId: "Room", objectId: "missing", propertyId: "temperature" },
      ],
      limitPerSeries: 1,
      order: "desc",
    })

    expect(batch.map((series) => series.points.map((point) => point.value))).toEqual([
      [21],
      [40],
      [],
    ])
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
      await storage.applyTelemetryAppended(event)
    }

    const history = await storage.getHistory({
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

    await storage.applyTelemetryAppended(event1)
    await storage.applyTelemetryAppended(event3)
    await storage.applyTelemetryAppended(event2)

    const latest = await storage.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    expect(latest?.value).toBe(23)
  })

  test("getLatest returns null for no data", async () => {
    const latest = await storage.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:999",
      propertyId: "temperature",
    })

    expect(latest).toBeNull()
  })

  test("stores different object ids separately", async () => {
    const now = new Date().toISOString()

    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22, now, "1")
    )
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:102", "temperature", 25, now, "2")
    )

    const latest101 = await storage.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })

    const latest102 = await storage.getLatest({
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

    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22, now, "1")
    )
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "humidity", 50, now, "2")
    )

    const history = await storage.getHistory({
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

    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Sensor", "sensor:1", "position", complexValue, now, "1")
    )

    const latest = await storage.getLatest({
      projectId: "project-a",
      objectTypeId: "Sensor",
      objectId: "sensor:1",
      propertyId: "position",
    })

    expect(latest?.value).toEqual(complexValue)
  })

  test("supports file persistence", async () => {
    const tempDir = `/tmp/test-timeseries-${Date.now()}`
    const tempFile = `${tempDir}/storage.sqlite`
    const now = new Date().toISOString()
    await migrateSqliteDatabase(tempFile)

    // Create and write
    const storage1 = new SqliteTimeseriesStorage({ path: tempFile })
    await storage1.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22.5, now, "1")
    )
    storage1.close()

    // Reopen and read
    const storage2 = new SqliteTimeseriesStorage({ path: tempFile })
    const latest = await storage2.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })
    storage2.close()

    expect(latest?.value).toBe(22.5)

    // Cleanup
    await rm(tempDir, { recursive: true, force: true })
  })

  test("handles different data types", async () => {
    const now = new Date().toISOString()

    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "temp", 22.5, now, "1")
    )
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "occupied", true, now, "2")
    )
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "count", 42, now, "3")
    )
    await storage.applyTelemetryAppended(
      createTelemetryEvent("project-a", "Room", "room:101", "label", "Conference", now, "4")
    )

    const temp = await storage.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temp",
    })
    const occupied = await storage.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "occupied",
    })
    const count = await storage.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "count",
    })
    const label = await storage.getLatest({
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
})
