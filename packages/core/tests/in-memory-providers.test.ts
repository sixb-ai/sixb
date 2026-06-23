import { describe, expect, test } from "bun:test"
import type {
  StoredLinkRemovedEvent,
  StoredLinkUpsertedEvent,
  StoredObjectUpsertedEvent,
  StoredTelemetryAppendedEvent,
} from "../src/events"
import type { ObjectStorage } from "../src/storage"
import { InMemoryObjectStorage, InMemoryTimeseriesStorage } from "../src/storage"

function makeObjectUpsertedEvent(
  projectId: string,
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, unknown>,
  cursor = "1"
): StoredObjectUpsertedEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    schemaVersion: 1,
    projectId,
    type: "object.upserted",
    topic: "objects",
    partitionKey: `${objectTypeId}:${primaryId}`,
    occurredAt: new Date().toISOString(),
    cursor,
    payload: { objectTypeId, primaryId, properties },
  }
}

function makeTelemetryEvent(
  projectId: string,
  objectTypeId: string,
  objectId: string,
  propertyId: string,
  value: unknown,
  at: Date,
  cursor = "1",
  unit?: string
): StoredTelemetryAppendedEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    schemaVersion: 1,
    projectId,
    type: "telemetry.appended",
    topic: "telemetry",
    partitionKey: `${objectTypeId}:${objectId}:${propertyId}`,
    occurredAt: at.toISOString(),
    cursor,
    payload: { objectTypeId, objectId, propertyId, value, unit, at: at.toISOString() },
  }
}

function makeLinkUpsertedEvent(
  projectId: string,
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  targetTypeId: string,
  targetId: string,
  cursor = "1",
  properties?: Record<string, unknown>
): StoredLinkUpsertedEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    schemaVersion: 1,
    projectId,
    type: "link.upserted",
    topic: "links",
    partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
    occurredAt: new Date().toISOString(),
    cursor,
    payload: { sourceTypeId, sourceId, linkId, targetTypeId, targetId, properties },
  }
}

function makeLinkRemovedEvent(
  projectId: string,
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  targetTypeId: string,
  targetId: string,
  cursor = "1"
): StoredLinkRemovedEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    schemaVersion: 1,
    projectId,
    type: "link.removed",
    topic: "links",
    partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
    occurredAt: new Date().toISOString(),
    cursor,
    payload: { sourceTypeId, sourceId, linkId, targetTypeId, targetId },
  }
}

describe("InMemoryObjectStorage", () => {
  test("declares object query capabilities", () => {
    const storage = new InMemoryObjectStorage()
    const objectStorage: ObjectStorage = storage

    const capabilities = storage.queryCapabilities()

    expect(capabilities.queryObjects).toBe(true)
    expect(capabilities.countObjects).toBe(true)
    expect(capabilities.existsObjects).toBe(true)
    expect(capabilities.facetObjects).toBe(true)
    expect(capabilities.nodes?.filter).toBe(true)
    expect(capabilities.predicateOps?.contains).toBe(true)
    expect(capabilities.sortKinds?.relevance).toBe(true)
    expect(capabilities.traversalDirections?.incoming).toBe(true)
    expect(capabilities.setOps?.intersect).toBe(true)
    expect(objectStorage.queryObjects).toBeDefined()
    expect(objectStorage.countObjects).toBeDefined()
    expect(objectStorage.existsObjects).toBeDefined()
    expect(objectStorage.facetObjects).toBeDefined()
  })

  test("queryObjects executes predicates, sort, limit, and projection", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r1", {
        name: "Alpha Room",
        status: "paused",
        floor: 1,
        tags: ["office"],
      })
    )
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r2", {
        name: "Beta Lab",
        status: "active",
        floor: 2,
        tags: ["lab"],
      })
    )
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r3", {
        name: "Alpha Lab",
        status: "active",
        floor: 3,
        tags: ["lab", "critical"],
      })
    )

    const result = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "project",
        properties: ["name", "floor"],
        input: {
          kind: "limit",
          limit: 2,
          input: {
            kind: "sort",
            fields: [{ kind: "property", propertyId: "floor", direction: "desc" }],
            input: {
              kind: "filter",
              predicate: {
                op: "and",
                items: [
                  { op: "eq", propertyId: "status", value: "active" },
                  { op: "gte", propertyId: "floor", value: 2 },
                  { op: "contains", propertyId: "tags", value: "lab" },
                  { op: "exists", propertyId: "missing", value: false },
                  { op: "not", item: { op: "eq", propertyId: "name", value: "Hidden" } },
                ],
              },
              input: { kind: "start", objectTypeId: "Room" },
            },
          },
        },
      },
    })

    expect(result.objects.map((row) => row.primaryId)).toEqual(["r3", "r2"])
    expect(result.objects[0].properties).toEqual({ name: "Alpha Lab", floor: 3 })
    expect(result.total).toBe(2)
    expect(result.hasMore).toBe(false)
  })

  test("queryObjects executes page tokens", async () => {
    const storage = new InMemoryObjectStorage()
    for (const primaryId of ["r1", "r2", "r3"]) {
      await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", primaryId, {}))
    }

    const page1 = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "page",
        pageSize: 2,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
          input: { kind: "start", objectTypeId: "Room" },
        },
      },
    })

    const page2 = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "page",
        pageSize: 2,
        pageToken: page1.nextPageToken,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
          input: { kind: "start", objectTypeId: "Room" },
        },
      },
    })

    expect(page1.objects.map((row) => row.primaryId)).toEqual(["r1", "r2"])
    expect(page1.total).toBe(3)
    expect(page1.hasMore).toBe(true)
    expect(page1.nextPageToken).toBe("offset:2")
    expect(page2.objects.map((row) => row.primaryId)).toEqual(["r3"])
    expect(page2.hasMore).toBe(false)
  })

  test("queryObjects executes text and vector search with relevance sort", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r1", {
        name: "Alpha Alpha",
        embedding: [1, 0],
      })
    )
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r2", {
        name: "Alpha Beta",
        embedding: [0.8, 0.2],
      })
    )
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r3", {
        name: "Gamma",
        embedding: [0, 1],
      })
    )

    const text = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "sort",
        fields: [{ kind: "relevance" }],
        input: {
          kind: "text",
          query: "alpha",
          fields: ["name"],
          input: { kind: "start", objectTypeId: "Room" },
        },
      },
    })

    const vector = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "vector",
        propertyId: "embedding",
        vector: [1, 0],
        k: 2,
        input: { kind: "start", objectTypeId: "Room" },
      },
    })

    expect(text.objects.map((row) => row.primaryId)).toEqual(["r1", "r2"])
    expect(vector.objects.map((row) => row.primaryId)).toEqual(["r1", "r2"])
    expect(vector.total).toBe(3)
    expect(vector.hasMore).toBe(true)
  })

  test("queryObjects executes traversal and set operations", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r1", { status: "active", tags: ["lab"] })
    )
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r2", { status: "active", tags: ["office"] })
    )
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r3", { status: "paused", tags: ["lab"] })
    )
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Device", "d1", {}))
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Device", "d2", {}))
    await storage.applyLinkUpserted(
      makeLinkUpsertedEvent("p1", "Room", "r1", "hasDevice", "Device", "d1")
    )
    await storage.applyLinkUpserted(
      makeLinkUpsertedEvent("p1", "Room", "r2", "hasDevice", "Device", "d2")
    )

    const outgoing = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "traverse",
        direction: "outgoing",
        linkId: "hasDevice",
        input: { kind: "start", objectTypeId: "Room" },
      },
    })

    const incoming = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "traverse",
        direction: "incoming",
        linkId: "hasDevice",
        input: { kind: "start", objectTypeId: "Device" },
      },
    })

    const intersect = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "set",
        op: "intersect",
        inputs: [
          {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "active" },
            input: { kind: "start", objectTypeId: "Room" },
          },
          {
            kind: "filter",
            predicate: { op: "contains", propertyId: "tags", value: "lab" },
            input: { kind: "start", objectTypeId: "Room" },
          },
        ],
      },
    })

    const subtract = await storage.queryObjects({
      projectId: "p1",
      query: {
        kind: "set",
        op: "subtract",
        inputs: [
          { kind: "start", objectTypeId: "Room" },
          {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "paused" },
            input: { kind: "start", objectTypeId: "Room" },
          },
        ],
      },
    })

    expect(outgoing.objects.map((row) => row.primaryId)).toEqual(["d1", "d2"])
    expect(incoming.objects.map((row) => row.primaryId)).toEqual(["r1", "r2"])
    expect(intersect.objects.map((row) => row.primaryId)).toEqual(["r1"])
    expect(subtract.objects.map((row) => row.primaryId)).toEqual(["r1", "r2"])
  })

  test("applyObjectUpserted creates and updates objects", async () => {
    const storage = new InMemoryObjectStorage()

    const event1 = makeObjectUpsertedEvent("p1", "Room", "r1", { name: "A" }, "1")
    const row1 = await storage.applyObjectUpserted(event1)
    expect(row1.primaryId).toBe("r1")
    expect(row1.properties.name).toBe("A")
    expect(row1.version).toBe(1)

    const event2 = makeObjectUpsertedEvent("p1", "Room", "r1", { name: "B" }, "2")
    const row2 = await storage.applyObjectUpserted(event2)
    expect(row2.properties.name).toBe("B")
    expect(row2.version).toBe(2)
  })

  test("applyObjectUpserted is idempotent", async () => {
    const storage = new InMemoryObjectStorage()
    const event = makeObjectUpsertedEvent("p1", "Room", "r1", { name: "A" }, "1")

    const row1 = await storage.applyObjectUpserted(event)
    const row2 = await storage.applyObjectUpserted(event)
    expect(row1.version).toBe(1)
    expect(row2.version).toBe(1)
  })

  test("getByPrimaryId returns null for non-existent objects", async () => {
    const storage = new InMemoryObjectStorage()
    const result = await storage.getByPrimaryId({
      projectId: "p1",
      objectTypeId: "Room",
      primaryId: "missing",
    })
    expect(result).toBeNull()
  })

  test("list with pagination", async () => {
    const storage = new InMemoryObjectStorage()
    for (let i = 1; i <= 5; i++) {
      await storage.applyObjectUpserted(
        makeObjectUpsertedEvent("p1", "Room", `r${i}`, { name: `Room ${i}` }, `${i}`)
      )
    }

    const page1 = await storage.list({ projectId: "p1", objectTypeId: "Room", limit: 2 })
    expect(page1.objects).toHaveLength(2)
    expect(page1.total).toBe(5)
    expect(page1.hasMore).toBe(true)

    const countOnly = await storage.list({ projectId: "p1", objectTypeId: "Room", limit: 0 })
    expect(countOnly.objects).toHaveLength(0)
    expect(countOnly.total).toBe(5)
    expect(countOnly.hasMore).toBe(true)

    const page2 = await storage.list({ projectId: "p1", objectTypeId: "Room", limit: 2, offset: 4 })
    expect(page2.objects).toHaveLength(1)
    expect(page2.hasMore).toBe(false)
  })

  test("list with primaryIdPrefix filter", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "room:a", {}, "1"))
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "room:b", {}, "2"))
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "other:c", {}, "3"))

    const result = await storage.list({
      projectId: "p1",
      objectTypeId: "Room",
      primaryIdPrefix: "room:",
    })
    expect(result.objects).toHaveLength(2)
  })

  test("list with primaryIdSuffix filter", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "room:a", {}, "1"))
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "room:b", {}, "2"))

    const result = await storage.list({
      projectId: "p1",
      objectTypeId: "Room",
      primaryIdSuffix: ":a",
    })
    expect(result.objects).toHaveLength(1)
    expect(result.objects[0].primaryId).toBe("room:a")
  })

  test("list orders by key asc", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "c", {}, "1"))
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "a", {}, "2"))
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "b", {}, "3"))

    const result = await storage.list({
      projectId: "p1",
      objectTypeId: "Room",
      orderBy: "primaryId",
      order: "asc",
    })
    expect(result.objects.map((o) => o.primaryId)).toEqual(["a", "b", "c"])
  })

  test("list across multiple object types", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Room", "r1", {}, "1"))
    await storage.applyObjectUpserted(makeObjectUpsertedEvent("p1", "Device", "d1", {}, "2"))

    const all = await storage.list({ projectId: "p1" })
    expect(all.objects).toHaveLength(2)
  })

  test("applyTelemetryAppended projects value onto object", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpserted(
      makeObjectUpsertedEvent("p1", "Room", "r1", { name: "A" }, "1")
    )

    const telEvent = makeTelemetryEvent("p1", "Room", "r1", "temp", 22.5, new Date(), "2")
    await storage.applyTelemetryAppended(telEvent)

    const row = await storage.getByPrimaryId({
      projectId: "p1",
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(row?.properties.temp).toBe(22.5)
  })

  test("applyLinkUpserted and listLinks", async () => {
    const storage = new InMemoryObjectStorage()
    const event = makeLinkUpsertedEvent("p1", "Room", "r1", "hasDevice", "Device", "d1", "1")
    await storage.applyLinkUpserted(event)

    const links = await storage.listLinks({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
    })
    expect(links).toHaveLength(1)
    expect(links[0].targetId).toBe("d1")
  })

  test("applyLinkRemoved deletes link", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyLinkUpserted(
      makeLinkUpsertedEvent("p1", "Room", "r1", "hasDevice", "Device", "d1", "1")
    )

    await storage.applyLinkRemoved(
      makeLinkRemovedEvent("p1", "Room", "r1", "hasDevice", "Device", "d1", "2")
    )

    const links = await storage.listLinks({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
    })
    expect(links).toHaveLength(0)
  })

  test("listLinks filters by linkId", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyLinkUpserted(
      makeLinkUpsertedEvent("p1", "Room", "r1", "hasDevice", "Device", "d1", "1")
    )
    await storage.applyLinkUpserted(
      makeLinkUpsertedEvent("p1", "Room", "r1", "hasNeighbor", "Room", "r2", "2")
    )

    const deviceLinks = await storage.listLinks({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "hasDevice",
    })
    expect(deviceLinks).toHaveLength(1)
    expect(deviceLinks[0].linkId).toBe("hasDevice")
  })

  test("listLinks supports incoming and both directions", async () => {
    const storage = new InMemoryObjectStorage()
    await storage.applyLinkUpserted(
      makeLinkUpsertedEvent("p1", "Room", "r1", "hasDevice", "Device", "d1", "1")
    )
    await storage.applyLinkUpserted(
      makeLinkUpsertedEvent("p1", "Device", "d1", "installedIn", "Room", "r1", "2")
    )

    const incoming = await storage.listLinks({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      direction: "incoming",
    })
    const both = await storage.listLinks({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      direction: "both",
    })

    expect(incoming.map((link) => link.linkId)).toEqual(["installedIn"])
    expect(both.map((link) => link.linkId).sort()).toEqual(["hasDevice", "installedIn"])
  })
})

describe("InMemoryTimeseriesStorage", () => {
  test("stores and retrieves latest point", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const t1 = new Date("2026-01-01T10:00:00Z")
    const t2 = new Date("2026-01-01T11:00:00Z")

    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 20, t1, "1")
    )
    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 22, t2, "2")
    )

    const latest = await storage.getLatest({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
    })
    expect(latest?.value).toBe(22)
  })

  test("upserts on equal timestamps: one point per instant, last value wins", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const at = new Date("2026-01-01T10:00:00Z")

    // A telemetry point is identified by (series, at), so two appends at the
    // same instant collapse to a single point with the last-written value.
    await storage.applyTelemetryAppended({
      ...makeTelemetryEvent("p1", "Room", "r1", "temp", 22, at),
      id: "evt-1",
    })
    await storage.applyTelemetryAppended({
      ...makeTelemetryEvent("p1", "Room", "r1", "temp", 20, at),
      id: "evt-2",
    })

    const history = await storage.getHistory({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
    })
    expect(history).toHaveLength(1)
    expect(history[0]?.value).toBe(20)

    const latest = await storage.getLatest({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
    })
    expect(latest?.value).toBe(20)
  })

  test("getHistory returns points in order", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const t1 = new Date("2026-01-01T10:00:00Z")
    const t2 = new Date("2026-01-01T11:00:00Z")
    const t3 = new Date("2026-01-01T12:00:00Z")

    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 20, t1, "1")
    )
    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 22, t2, "2")
    )
    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 24, t3, "3")
    )

    const asc = await storage.getHistory({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
      order: "asc",
    })
    expect(asc.map((p) => p.value)).toEqual([20, 22, 24])

    const desc = await storage.getHistory({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
      order: "desc",
    })
    expect(desc.map((p) => p.value)).toEqual([24, 22, 20])
  })

  test("getHistory filters by time range", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const t1 = new Date("2026-01-01T10:00:00Z")
    const t2 = new Date("2026-01-01T11:00:00Z")
    const t3 = new Date("2026-01-01T12:00:00Z")

    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 20, t1, "1")
    )
    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 22, t2, "2")
    )
    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 24, t3, "3")
    )

    const filtered = await storage.getHistory({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
      from: new Date("2026-01-01T10:30:00Z"),
      to: new Date("2026-01-01T11:30:00Z"),
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].value).toBe(22)
  })

  test("getHistory with limit", async () => {
    const storage = new InMemoryTimeseriesStorage()
    for (let i = 0; i < 5; i++) {
      const at = new Date(`2026-01-01T${10 + i}:00:00Z`)
      await storage.applyTelemetryAppended(
        makeTelemetryEvent("p1", "Room", "r1", "temp", 20 + i, at, `${i + 1}`)
      )
    }

    const limited = await storage.getHistory({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
      limit: 3,
    })
    expect(limited).toHaveLength(3)
  })

  test("getHistoryBatch returns requested series with per-series limits", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const t1 = new Date("2026-01-01T10:00:00Z")
    const t2 = new Date("2026-01-01T11:00:00Z")

    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 20, t1, "1")
    )
    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "temp", 22, t2, "2")
    )
    await storage.applyTelemetryAppended(
      makeTelemetryEvent("p1", "Room", "r1", "humidity", 40, t1, "3")
    )

    const batch = await storage.getHistoryBatch({
      projectId: "p1",
      series: [
        { objectTypeId: "Room", objectId: "r1", propertyId: "temp" },
        { objectTypeId: "Room", objectId: "r1", propertyId: "humidity" },
        { objectTypeId: "Room", objectId: "missing", propertyId: "temp" },
      ],
      limitPerSeries: 1,
      order: "desc",
    })

    expect(batch.map((series) => series.points.map((point) => point.value))).toEqual([
      [22],
      [40],
      [],
    ])
  })

  test("applyTelemetryAppended is idempotent", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const event = makeTelemetryEvent("p1", "Room", "r1", "temp", 22, new Date(), "1")

    await storage.applyTelemetryAppended(event)
    await storage.applyTelemetryAppended(event)

    const history = await storage.getHistory({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
    })
    expect(history).toHaveLength(1)
  })

  test("getLatest returns null for no data", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const latest = await storage.getLatest({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
    })
    expect(latest).toBeNull()
  })

  test("stores unit alongside value", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const event = makeTelemetryEvent(
      "p1",
      "Room",
      "r1",
      "temp",
      22,
      new Date(),
      "1",
      "degreeCelsius"
    )
    await storage.applyTelemetryAppended(event)

    const latest = await storage.getLatest({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temp",
    })
    expect(latest?.unit).toBe("degreeCelsius")
  })
})
