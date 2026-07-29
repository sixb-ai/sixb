import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { JsonValue } from "@sixb/core"
import type {
  StoredLinkDeletedEvent,
  StoredLinkMutationEvent,
  StoredObjectMutationEvent,
  StoredTelemetryAppendedEvent,
} from "@sixb/core/internal/events"
import {
  createStoredLinkDeletedEvent,
  createStoredLinkMutationEvent,
  createStoredObjectMutationEvent,
  createStoredTelemetryAppendedEvent,
} from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

describe("PgObjectStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  function createObjectEvent(
    projectId: string,
    objectTypeId: string,
    primaryId: string,
    properties: Record<string, JsonValue>,
    cursor: string
  ): StoredObjectMutationEvent {
    return createStoredObjectMutationEvent({
      id: `event-${cursor}`,
      cursor,
      projectId,
      occurredAt: new Date().toISOString(),
      objectTypeId,
      primaryId,
      properties,
    })
  }

  function createTelemetryEvent(
    projectId: string,
    objectTypeId: string,
    objectId: string,
    propertyId: string,
    value: JsonValue,
    cursor: string
  ): StoredTelemetryAppendedEvent {
    const at = new Date().toISOString()
    return createStoredTelemetryAppendedEvent({
      id: `event-${cursor}`,
      cursor,
      projectId,
      occurredAt: at,
      objectTypeId,
      objectId,
      propertyId,
      value,
      at,
    })
  }

  function createLinkMutationEvent(
    projectId: string,
    sourceTypeId: string,
    sourceId: string,
    linkId: string,
    targetTypeId: string,
    targetId: string,
    cursor: string
  ): StoredLinkMutationEvent {
    return createStoredLinkMutationEvent({
      id: `event-${cursor}`,
      cursor,
      projectId,
      occurredAt: new Date().toISOString(),
      sourceTypeId,
      sourceId,
      linkId,
      targetTypeId,
      targetId,
    })
  }

  function createLinkDeletedEvent(
    projectId: string,
    sourceTypeId: string,
    sourceId: string,
    linkId: string,
    targetTypeId: string,
    targetId: string,
    cursor: string
  ): StoredLinkDeletedEvent {
    return createStoredLinkDeletedEvent({
      id: `event-${cursor}`,
      cursor,
      projectId,
      occurredAt: new Date().toISOString(),
      sourceTypeId,
      sourceId,
      linkId,
      targetTypeId,
      targetId,
    })
  }

  test("applyObjectUpsert creates new object", async () => {
    const event = createObjectEvent("project-a", "Room", "room:101", { name: "Conference" }, "1")
    const row = await storage.objects.applyObjectUpsert(event)

    expect(row.primaryId).toBe("room:101")
    expect(row.objectTypeId).toBe("Room")
    expect(row.properties.name).toBe("Conference")
    expect(row.projectId).toBe("project-a")
    expect(row.version).toBe(1)
    expect(row.sourceEventId).toBe("event-1")
  })

  test("applyObjectUpsert merges properties", async () => {
    const event1 = createObjectEvent(
      "project-a",
      "Room",
      "room:101",
      { name: "Conference", floor: "2" },
      "1"
    )
    await storage.objects.applyObjectUpsert(event1)

    const event2 = createObjectEvent("project-a", "Room", "room:101", { capacity: 20 }, "2")
    const row = await storage.objects.applyObjectUpsert(event2)

    expect(row.properties.name).toBe("Conference")
    expect(row.properties.floor).toBe("2")
    expect(row.properties.capacity).toBe(20)
    expect(row.version).toBe(2)
  })

  test("applyObjectUpsert is idempotent", async () => {
    const event = createObjectEvent("project-a", "Room", "room:101", { name: "Conference" }, "1")

    await storage.objects.applyObjectUpsert(event)
    await storage.objects.applyObjectUpsert(event) // Same event ID

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(row?.version).toBe(1)
  })

  test("getByPrimaryId returns correct object", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", { name: "Room 1" }, "1")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:102", { name: "Room 2" }, "2")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-b", "Room", "room:101", { name: "Room 3" }, "3")
    )

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })

    expect(row?.properties.name).toBe("Room 1")
  })

  test("getByPrimaryId returns null for non-existent object", async () => {
    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:999",
    })
    expect(row).toBeNull()
  })

  test("applyTelemetryAppended updates object property", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", { name: "Conference" }, "1")
    )

    const telemetryEvent = createTelemetryEvent(
      "project-a",
      "Room",
      "room:101",
      "temperature",
      22.5,
      "2"
    )
    await storage.objects.applyTelemetryAppended(telemetryEvent)

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(row?.properties.temperature).toBe(22.5)
    expect(row?.properties.name).toBe("Conference")
    expect(row?.version).toBe(2)
  })

  test("applyTelemetryAppended is idempotent", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", {}, "1")
    )

    const event = createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22.5, "2")
    await storage.objects.applyTelemetryAppended(event)
    await storage.objects.applyTelemetryAppended(event) // Same event ID

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(row?.version).toBe(2)
  })

  test("applyLinkUpsert creates link", async () => {
    const event = createLinkMutationEvent(
      "project-a",
      "Room",
      "room:101",
      "hasThermostat",
      "Thermostat",
      "tstat:abc",
      "1"
    )
    await storage.objects.applyLinkUpsert(event)

    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.linkId).toBe("hasThermostat")
    expect(links[0]?.targetTypeId).toBe("Thermostat")
    expect(links[0]?.targetId).toBe("tstat:abc")
  })

  test("applyLinkUpsert updates existing link", async () => {
    const event1 = createLinkMutationEvent(
      "project-a",
      "Room",
      "room:101",
      "hasThermostat",
      "Thermostat",
      "tstat:abc",
      "1"
    )
    await storage.objects.applyLinkUpsert(event1)

    const event2 = createLinkMutationEvent(
      "project-a",
      "Room",
      "room:101",
      "hasThermostat",
      "Thermostat",
      "tstat:abc",
      "2"
    )
    await storage.objects.applyLinkUpsert(event2)

    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.sourceEventId).toBe("event-2")
  })

  test("applyLinkDelete removes link", async () => {
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Room",
        "room:101",
        "hasThermostat",
        "Thermostat",
        "tstat:abc",
        "1"
      )
    )

    await storage.objects.applyLinkDelete(
      createLinkDeletedEvent(
        "project-a",
        "Room",
        "room:101",
        "hasThermostat",
        "Thermostat",
        "tstat:abc",
        "2"
      )
    )

    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
    })

    expect(links).toHaveLength(0)
  })

  test("listLinks filters by linkId", async () => {
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Room",
        "room:101",
        "hasThermostat",
        "Thermostat",
        "tstat:1",
        "1"
      )
    )
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Room",
        "room:101",
        "hasSensor",
        "Sensor",
        "sensor:1",
        "2"
      )
    )

    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      linkId: "hasThermostat",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.linkId).toBe("hasThermostat")
  })

  test("listLinks supports incoming and both directions", async () => {
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent("project-a", "Room", "room:101", "hasSensor", "Sensor", "s1", "1")
    )
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent("project-a", "Sensor", "s1", "installedIn", "Room", "room:101", "2")
    )

    const incoming = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      direction: "incoming",
    })
    const both = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      direction: "both",
    })

    expect(incoming.map((link) => link.linkId)).toEqual(["installedIn"])
    expect(both.map((link) => link.linkId).sort()).toEqual(["hasSensor", "installedIn"])
  })

  test("list returns objects with pagination", async () => {
    for (let i = 1; i <= 5; i++) {
      await storage.objects.applyObjectUpsert(
        createObjectEvent("project-a", "Room", `room:10${i}`, { name: `Room ${i}` }, `${i}`)
      )
    }

    const result = await storage.objects.list({
      projectId: "project-a",
      objectTypeId: "Room",
      limit: 2,
      offset: 0,
    })

    expect(result.objects).toHaveLength(2)
    expect(result.total).toBe(5)
    expect(result.hasMore).toBe(true)

    const countOnly = await storage.objects.list({
      projectId: "project-a",
      objectTypeId: "Room",
      limit: 0,
    })
    expect(countOnly.objects).toHaveLength(0)
    expect(countOnly.total).toBe(5)
    expect(countOnly.hasMore).toBe(true)
  })

  test("listByPrimaryIdPage uses a stable keyset without totals", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:103", {}, "3")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", {}, "1")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:102", {}, "2")
    )

    const first = await storage.objects.listByPrimaryIdPage({
      projectId: "project-a",
      objectTypeId: "Room",
      limit: 2,
    })
    const second = await storage.objects.listByPrimaryIdPage({
      projectId: "project-a",
      objectTypeId: "Room",
      afterPrimaryId: first.nextPrimaryId,
      limit: 2,
    })

    expect(first.objects.map((row) => row.primaryId)).toEqual(["room:101", "room:102"])
    expect(first.nextPrimaryId).toBe("room:102")
    expect(second.objects.map((row) => row.primaryId)).toEqual(["room:103"])
    expect(second.nextPrimaryId).toBeUndefined()
  })

  test("list with primaryIdPrefix filter", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", {}, "1")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:102", {}, "2")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "building:a", {}, "3")
    )

    const result = await storage.objects.list({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryIdPrefix: "room:",
    })

    expect(result.objects).toHaveLength(2)
  })

  test("list with primaryIdSuffix filter", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", {}, "1")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "zone:101", {}, "2")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:102", {}, "3")
    )

    const result = await storage.objects.list({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryIdSuffix: "101",
    })

    expect(result.objects).toHaveLength(2)
  })

  test("list with time filters", async () => {
    const now = new Date()
    const past = new Date(now.getTime() - 10000)
    const future = new Date(now.getTime() + 10000)

    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:past", {}, "1")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:future", {}, "2")
    )

    const result = await storage.objects.list({
      projectId: "project-a",
      objectTypeId: "Room",
      createdAfter: past,
      createdBefore: future,
    })

    expect(result.objects.length).toBeGreaterThanOrEqual(2)
  })

  test("list with ordering", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:b", {}, "1")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:a", {}, "2")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:c", {}, "3")
    )

    const result = await storage.objects.list({
      projectId: "project-a",
      objectTypeId: "Room",
      orderBy: "primaryId",
      order: "asc",
    })

    expect(result.objects[0]?.primaryId).toBe("room:a")
    expect(result.objects[1]?.primaryId).toBe("room:b")
    expect(result.objects[2]?.primaryId).toBe("room:c")
  })

  test("applyTelemetryAppendedBatch updates multiple properties on same object", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", { name: "Conference" }, "1")
    )

    const events: StoredTelemetryAppendedEvent[] = [
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22.5, "10"),
      createTelemetryEvent("project-a", "Room", "room:101", "humidity", 45, "11"),
      createTelemetryEvent("project-a", "Room", "room:101", "co2", 400, "12"),
    ]

    await storage.objects.applyTelemetryAppendedBatch(events)

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })

    expect(row?.properties.name).toBe("Conference")
    expect(row?.properties.temperature).toBe(22.5)
    expect(row?.properties.humidity).toBe(45)
    expect(row?.properties.co2).toBe(400)
    expect(row?.version).toBe(4) // 1 (create) + 3 (batch)
  })

  test("applyTelemetryAppendedBatch is idempotent", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", {}, "1")
    )

    const events: StoredTelemetryAppendedEvent[] = [
      createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22.5, "10"),
      createTelemetryEvent("project-a", "Room", "room:101", "humidity", 45, "11"),
    ]

    await storage.objects.applyTelemetryAppendedBatch(events)
    await storage.objects.applyTelemetryAppendedBatch(events) // Replay same batch

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(row?.version).toBe(3) // 1 (create) + 2 (first batch only)
  })

  test("applyTelemetryAppendedBatch handles empty array", async () => {
    await storage.objects.applyTelemetryAppendedBatch([])
    // Should not throw
  })

  test("applyTelemetryAppendedBatch skips non-existent objects", async () => {
    const events: StoredTelemetryAppendedEvent[] = [
      createTelemetryEvent("project-a", "Room", "room:ghost", "temperature", 22.5, "10"),
    ]

    // Should not throw
    await storage.objects.applyTelemetryAppendedBatch(events)
  })

  test("applyLinkUpsert stores link properties", async () => {
    const event: StoredLinkMutationEvent = createStoredLinkMutationEvent({
      id: "event-link-props",
      cursor: "1",
      projectId: "project-a",
      occurredAt: new Date().toISOString(),
      sourceTypeId: "Room",
      sourceId: "room:101",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:abc",
      properties: { isPrimary: true, priority: 1 },
    })

    await storage.objects.applyLinkUpsert(event)

    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      linkId: "hasThermostat",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.properties).toEqual({ isPrimary: true, priority: 1 })
  })

  test("concurrent applyObjectUpsert on same primaryId produces correct state", async () => {
    const event1: StoredObjectMutationEvent = createStoredObjectMutationEvent({
      id: "concurrent-event-1",
      cursor: "1",
      projectId: "project-a",
      occurredAt: new Date().toISOString(),
      objectTypeId: "Room",
      primaryId: "room:race",
      properties: { name: "Race Room", floor: "1" },
    })

    const event2: StoredObjectMutationEvent = createStoredObjectMutationEvent({
      id: "concurrent-event-2",
      cursor: "2",
      projectId: "project-a",
      occurredAt: new Date().toISOString(),
      objectTypeId: "Room",
      primaryId: "room:race",
      properties: { capacity: 20, zone: "B" },
    })

    // Fire both concurrently
    await Promise.all([
      storage.objects.applyObjectUpsert(event1),
      storage.objects.applyObjectUpsert(event2),
    ])

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:race",
    })

    // Both events applied: version must be 2
    expect(row?.version).toBe(2)
    // Properties from both events must be present (merged)
    expect(row?.properties.name).toBe("Race Room")
    expect(row?.properties.floor).toBe("1")
    expect(row?.properties.capacity).toBe(20)
    expect(row?.properties.zone).toBe("B")
  })

  // ── Batch methods ───────────────────────────────────────────

  test("applyObjectUpsertBatch — inserts multiple objects", async () => {
    const events = [
      createObjectEvent("p1", "Room", "r1", { name: "Kitchen" }, "1"),
      createObjectEvent("p1", "Room", "r2", { name: "Bedroom" }, "2"),
      createObjectEvent("p1", "Room", "r3", { name: "Bathroom" }, "3"),
    ]

    const results = await storage.objects.applyObjectUpsertBatch(events)

    expect(results).toHaveLength(3)
    expect(results[0].primaryId).toBe("r1")
    expect(results[1].primaryId).toBe("r2")
    expect(results[2].primaryId).toBe("r3")
    expect(results[0].properties.name).toBe("Kitchen")
  })

  test("applyObjectUpsertBatch — idempotent on replay", async () => {
    const events = [createObjectEvent("p1", "Room", "r1", { name: "Kitchen" }, "1")]

    await storage.objects.applyObjectUpsertBatch(events)
    const results = await storage.objects.applyObjectUpsertBatch(events)

    expect(results).toHaveLength(1)
    expect(results[0].primaryId).toBe("r1")
    expect(results[0].version).toBe(1)
  })

  test("applyLinkUpsertBatch — inserts multiple links", async () => {
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Room", "r1", {}, "1"))
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s1", {}, "2"))
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s2", {}, "3"))

    const events = [
      createLinkMutationEvent("p1", "Room", "r1", "hasSensors", "Sensor", "s1", "4"),
      createLinkMutationEvent("p1", "Room", "r1", "hasSensors", "Sensor", "s2", "5"),
    ]

    await storage.objects.applyLinkUpsertBatch(events)

    const links = await storage.objects.listLinks({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links).toHaveLength(2)
  })

  test("getByPrimaryIdBatch — returns found objects, omits missing", async () => {
    await storage.objects.applyObjectUpsert(
      createObjectEvent("p1", "Room", "r1", { name: "A" }, "1")
    )
    await storage.objects.applyObjectUpsert(
      createObjectEvent("p1", "Room", "r2", { name: "B" }, "2")
    )

    const result = await storage.objects.getByPrimaryIdBatch({
      projectId: "p1",
      items: [
        { objectTypeId: "Room", primaryId: "r1" },
        { objectTypeId: "Room", primaryId: "r2" },
        { objectTypeId: "Room", primaryId: "missing" },
      ],
    })

    expect(result.size).toBe(2)
    expect(result.get("Room:r1")?.properties.name).toBe("A")
    expect(result.get("Room:r2")?.properties.name).toBe("B")
    expect(result.has("Room:missing")).toBe(false)
  })

  test("listLinksBatch — returns found links, omits missing", async () => {
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Room", "r1", {}, "1"))
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s1", {}, "2"))
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent("p1", "Room", "r1", "hasSensors", "Sensor", "s1", "3")
    )

    const result = await storage.objects.listLinksBatch({
      projectId: "p1",
      items: [
        { objectTypeId: "Room", objectId: "r1", linkId: "hasSensors" },
        { objectTypeId: "Room", objectId: "r1", linkId: "noLinks" },
      ],
    })

    expect(result.size).toBe(1)
    expect(result.get("Room:r1:hasSensors")).toHaveLength(1)
    expect(result.has("Room:r1:noLinks")).toBe(false)
  })

  test("listIncidentLinksBatch — both directions, de-duplicated", async () => {
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Room", "r1", {}, "1"))
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Room", "r2", {}, "2"))
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s1", {}, "3"))
    await storage.objects.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s2", {}, "4"))

    // r1 as source
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent("p1", "Room", "r1", "hasSensors", "Sensor", "s1", "5")
    )
    // r1 as target
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent("p1", "Sensor", "s2", "installedIn", "Room", "r1", "6")
    )
    // incident to both listed objects (r1 source, r2 target)
    await storage.objects.applyLinkUpsert(
      createLinkMutationEvent("p1", "Room", "r1", "relatedTo", "Room", "r2", "7")
    )

    const links = await storage.objects.listIncidentLinksBatch({
      projectId: "p1",
      items: [
        { objectTypeId: "Room", objectId: "r1" },
        { objectTypeId: "Room", objectId: "r2" },
      ],
    })

    // hasSensors + installedIn + relatedTo. relatedTo is incident to both r1 and r2 but appears once.
    expect(links).toHaveLength(3)
    expect(links.filter((link) => link.linkId === "relatedTo")).toHaveLength(1)

    const empty = await storage.objects.listIncidentLinksBatch({ projectId: "p1", items: [] })
    expect(empty).toHaveLength(0)
  })
})
