import { describe, expect, test } from "bun:test"
import {
  defineAction,
  defineObjectType,
  defineOntology,
  defineValueType,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryQueues,
  link,
  MaterializationValidationError,
  ObjectNotFoundError,
  type ObjectQuery,
  ObjectQueryPlanningError,
  OntologyValidationError,
  optional,
  param,
  prop,
  SixbHost,
  valueTypeRef,
} from "../src"
import type { ObjectStorage, QueryObjectsInput, QueryObjectsResult } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("currentTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("exactReading", "decimal", { mode: "telemetry" }),
  ],
  links: [link.ref("hasThermostat", "Thermostat", { cardinality: "one" })],
})

const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
  ],
})

const Document = defineObjectType({
  id: "Document",
  name: "Document",
  properties: [prop("id", "string", { required: true, primary: true }), prop("file", "fileRef")],
})

const SearchCustomer = defineObjectType({
  id: "SearchCustomer",
  name: "Search Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: {
        searchable: true,
        text: true,
        filterable: true,
        sortable: true,
        weight: 3,
      },
    }),
    prop("email", "string", {
      query: { searchable: true, text: true, exact: true },
    }),
    prop("status", "string", {
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop(
      "embedding",
      { type: "array", items: "double" },
      {
        query: { searchable: true, vector: true },
      }
    ),
  ],
  search: {
    defaultText: ["name", "email"],
    vector: { property: "embedding", source: ["name", "email"] },
  },
})

function findQueryNode(query: ObjectQuery, kind: ObjectQuery["kind"]): ObjectQuery | null {
  if (query.kind === kind) return query
  if ("input" in query) return findQueryNode(query.input, kind)
  return null
}

function countObjectQueryCalls(deps: ReturnType<typeof createTestRuntimeDeps>): {
  readonly calls: number
} {
  let calls = 0
  const queryObjects = deps.storage.objects.queryObjects
  if (!queryObjects) throw new Error("Expected in-memory object query pushdown.")
  const originalQueryObjects = queryObjects.bind(deps.storage.objects)
  deps.storage.objects.queryObjects = async (
    input: QueryObjectsInput
  ): Promise<QueryObjectsResult> => {
    calls += 1
    return originalQueryObjects(input)
  }

  return {
    get calls() {
      return calls
    },
  }
}

function disableObjectQueryPushdown(deps: ReturnType<typeof createTestRuntimeDeps>): void {
  const objectStorage = deps.storage.objects as ObjectStorage
  objectStorage.queryCapabilities = () => ({
    queryObjects: false,
    notes: ["Object query pushdown disabled for this test."],
  })
  objectStorage.queryObjects = undefined
}

describe("SixbHost runtime", () => {
  test("groups primitive operations under domain-owned facades", () => {
    const sixb = createTestSixb({ ontology: [Room], ...createTestRuntimeDeps() })

    expect(typeof sixb.objects).toBe("function")
    expect(sixb.objects.listTypes().map((objectType) => objectType.id)).toContain("Room")
    expect(sixb.actions.list()).toEqual([])
    expect(sixb.datasets.list()).toEqual([])
    expect(sixb.syncs.list()).toEqual([])
    expect(sixb.pipelines.list()).toEqual([])
    expect(sixb.schedules.list()).toEqual([])
    expect(sixb.rules.list()).toEqual([])
    expect(sixb.projections.list()).toEqual([])
    expect(sixb.workflows.list()).toEqual([])
    expect(sixb.agents.list()).toEqual([])

    for (const removedRootMember of [
      "listObjects",
      "listActions",
      "requestAction",
      "listDatasets",
      "listSyncs",
      "listPipelines",
      "listWorkflows",
      "listAgents",
      "listSchedules",
      "startScheduler",
      "listRules",
      "listObjectProjections",
      "connectors",
      "blobStorage",
    ]) {
      expect(removedRootMember in sixb).toBe(false)
    }
  })

  test("upserts an object using object-type tokens", async () => {
    const sixb = createTestSixb({ ontology: [Room], ...createTestRuntimeDeps() })

    const room = await sixb.objects(Room).upsert({
      properties: {
        id: "room:101",
        externalId: "RM-101",
        name: "Conference 101",
      },
    })

    expect(room.primaryId).toBe("room:101")
    expect(room.objectTypeId).toBe("Room")
    expect(room.properties.externalId).toBe("RM-101")
    expect(room.properties.name).toBe("Conference 101")

    const found = await sixb
      .objects(Room)
      .query()
      .where((r) => r.p.externalId.eq("RM-101"))
      .first()

    expect(found?.primaryId).toBe("room:101")

    await expect(
      sixb.objects(Room).upsert({
        properties: {
          id: "room:invalid",
          externalId: "RM-INVALID",
          name: 101 as unknown as string,
        },
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      sixb.objects(Room).upsert({
        properties: {
          id: "room:invalid",
          externalId: "RM-INVALID",
          name: 101 as unknown as string,
        },
      })
    ).rejects.toThrow("must be a string")
  })

  test("builds executable ObjectSet queries", () => {
    const sixb = createTestSixb({ ontology: [SearchCustomer], ...createTestRuntimeDeps() })
    const customers = sixb.objects(SearchCustomer)

    const query = customers
      .query()
      .where((r) => r.and(r.p.status.eq("active"), r.p.name.contains("Acme")))
      .search("acme", { fields: [SearchCustomer.p.name, SearchCustomer.p.email] })
      .vector(SearchCustomer.p.embedding, [0.1, 0.2, 0.3], { k: 5 })
      .orderByRelevance()
      .orderBy(SearchCustomer.p.name, "asc")
      .limit(10)
    const textNode = findQueryNode(query.ir, "text")
    const sortNode = findQueryNode(query.ir, "sort")

    expect(query.ir.kind).toBe("limit")
    expect(textNode?.kind).toBe("text")
    if (textNode?.kind === "text") {
      expect(textNode.fields).toEqual(["name", "email"])
    }
    expect(sortNode?.kind).toBe("sort")
    if (sortNode?.kind === "sort") {
      expect(sortNode.fields).toEqual([
        { kind: "relevance", direction: undefined },
        { kind: "property", propertyId: "name", direction: "asc" },
      ])
    }

    const validated = customers
      .query()
      .where((r) => r.and(r.p.status.eq("active"), r.p.name.contains("Acme")))
      .search("acme", { fields: [SearchCustomer.p.name, SearchCustomer.p.email] })
      .vector(SearchCustomer.p.embedding, [0.1, 0.2, 0.3], { k: 5 })
      .orderByRelevance()
      .orderBy(SearchCustomer.p.name, "asc")
      .limit(10)
      .validate()
    expect(validated.result.objectTypeIds).toEqual(["SearchCustomer"])

    const explanation = customers
      .query()
      .where((r) => r.and(r.p.status.eq("active"), r.p.name.contains("Acme")))
      .search("acme", { fields: [SearchCustomer.p.name, SearchCustomer.p.email] })
      .vector(SearchCustomer.p.embedding, [0.1, 0.2, 0.3], { k: 5 })
      .orderByRelevance()
      .orderBy(SearchCustomer.p.name, "asc")
      .limit(10)
      .explain()
    expect(explanation.valid).toBe(true)
    expect(
      customers
        .query()
        .where((r) => r.and(r.p.status.eq("active"), r.p.name.contains("Acme")))
        .search("acme", { fields: [SearchCustomer.p.name, SearchCustomer.p.email] })
        .vector(SearchCustomer.p.embedding, [0.1, 0.2, 0.3], { k: 5 })
        .orderByRelevance()
        .orderBy(SearchCustomer.p.name, "asc")
        .limit(10)
        .formatExplanation()
    ).toContain("ObjectQuery valid")
  })

  test("executes ObjectSet queries through the query executor", async () => {
    const deps = createTestRuntimeDeps()
    const queryCounter = countObjectQueryCalls(deps)
    const sixb = createTestSixb({ ontology: [Room], ...deps })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:103", externalId: "RM-103", name: "Conference 103" },
    })

    const found = await sixb
      .objects(Room)
      .query()
      .where((r) => r.p.externalId.eq("RM-102"))
      .first()
    const listed = await sixb
      .objects(Room)
      .query()
      .where((r) => r.p.name.neq("Conference 103"))
      .limit(10)
      .list()

    expect(found?.primaryId).toBe("room:102")
    expect(
      (listed.objects as readonly { primaryId: string }[]).map((room) => room.primaryId)
    ).toEqual(["room:101", "room:102"])
    expect(queryCounter.calls).toBe(2)
  })

  test("executes fluent traversal queries with post-traverse filters", async () => {
    const sixb = createTestSixb({ ontology: [Room, Thermostat], ...createTestRuntimeDeps() })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    const thermostat = await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:101", externalId: "T-101", name: "Thermostat 101" },
    })
    await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, thermostat)

    const found = await sixb
      .objects(Room)
      .query()
      .where((room) => room.p.externalId.eq("RM-101"))
      .traverse(Room.l.hasThermostat)
      .where((thermostat) => thermostat.p.id.eq("tstat:101"))
      .first()

    expect(found?.objectTypeId).toBe("Thermostat")
    expect(found?.primaryId).toBe("tstat:101")
  })

  test("keeps ObjectSet list on the storage-list path", async () => {
    const deps = createTestRuntimeDeps()
    const queryCounter = countObjectQueryCalls(deps)
    const sixb = createTestSixb({ ontology: [Room], ...deps })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:201", externalId: "RM-201", name: "Conference 201" },
    })

    const prefixRooms = await sixb.objects(Room).list({ idPrefix: "room:10" })

    expect(
      (prefixRooms.objects as readonly { primaryId: string }[]).map((room) => room.primaryId).sort()
    ).toEqual(["room:101", "room:102"])
    expect(queryCounter.calls).toBe(0)

    const queriedRooms = await sixb
      .objects(Room)
      .query()
      .where((r) => r.p.name.neq("Conference 201"))
      .limit(10)
      .list()

    expect(queriedRooms.objects).toHaveLength(2)
    expect(queryCounter.calls).toBe(1)
  })

  test("explains how to bound fallback ObjectSet queries before list", async () => {
    const deps = createTestRuntimeDeps()
    disableObjectQueryPushdown(deps)
    const sixb = createTestSixb({ ontology: [Room], ...deps })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })

    try {
      await sixb
        .objects(Room)
        .query()
        .where((r) => r.p.externalId.eq("RM-101"))
        .list()
      throw new Error("Expected unbounded fallback query to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectQueryPlanningError)
      if (error instanceof ObjectQueryPlanningError) {
        expect(error.issues.map((issue) => issue.code)).toContain("fallback_requires_bound")
        expect(error.message).toContain("Add .limit(n) or .page({ pageSize: n }) before .list().")
      }
    }
  })

  test("exposes configured lakeStorage on the runtime", () => {
    const lakeStorage = new InMemoryLakeStorage()
    const sixb = new SixbHost({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      lakeStorage,
    })

    expect(sixb.lakeStorage).toBe(lakeStorage)
  })

  test("keeps the configured blob provider on the host", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const lakeStorage = new InMemoryLakeStorage()
    const sixb = new SixbHost({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      lakeStorage,
      blobStorage,
    })

    expect(sixb.blobStorage).toBe(blobStorage)
    const file = await sixb.blobStorage.put({ body: new TextEncoder().encode("provider") })
    expect(await blobStorage.stat(file.blobId)).not.toBeNull()
  })

  test("upserts objects with fileRef properties", async () => {
    const sixb = createTestSixb({ ontology: [Document], ...createTestRuntimeDeps() })
    const file = await sixb.blobs.put({
      body: new TextEncoder().encode("document bytes"),
      fileName: "document.pdf",
      mediaType: "application/pdf",
    })

    const document = await sixb.objects(Document).upsert({
      properties: {
        id: "doc:1",
        file,
      },
    })

    expect(document.properties.file).toEqual(file)

    await expect(
      sixb.objects(Document).upsert({
        properties: {
          id: "doc:2",
          file: { blobId: "blob_missing" } as unknown as typeof file,
        },
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      sixb.objects(Document).upsert({
        properties: {
          id: "doc:2",
          file: { blobId: "blob_missing" } as unknown as typeof file,
        },
      })
    ).rejects.toThrow("must be a fileRef")
  })

  test("exposes configured queues on the runtime", () => {
    const queues = new InMemoryQueues()
    const sixb = new SixbHost({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      queues,
    })

    expect(sixb.queues).toBe(queues)
  })

  test("exposes projection run storage from in-memory storage", () => {
    const sixb = new SixbHost({ ontology: [Room], ...createTestRuntimeDeps() })

    expect(sixb.storage.projectionRuns).toBeDefined()
  })

  test("appends telemetry with unit validation", async () => {
    const sixb = createTestSixb({ ontology: [Room], ...createTestRuntimeDeps() })

    await sixb.objects(Room).upsert({
      properties: {
        id: "room:101",
        externalId: "RM-101",
        name: "Conference 101",
      },
    })

    await sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
      value: 22.4,
      unit: "degreeCelsius",
      at: new Date(),
    })

    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .telemetry(Room.p.currentTemperature)
        .append({
          value: "hot" as unknown as number,
          unit: "degreeCelsius",
          at: new Date(),
        })
    ).rejects.toBeInstanceOf(MaterializationValidationError)
    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .telemetry(Room.p.currentTemperature)
        .append({
          value: "hot" as unknown as number,
          unit: "degreeCelsius",
          at: new Date(),
        })
    ).rejects.toThrow("must be numeric")

    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .telemetry(Room.p.currentTemperature)
        .append({
          value: 22.4,
          unit: "millibar" as unknown as "degreeCelsius",
          at: new Date(),
        })
    ).rejects.toBeInstanceOf(MaterializationValidationError)
    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .telemetry(Room.p.currentTemperature)
        .append({
          value: 22.4,
          unit: "millibar" as unknown as "degreeCelsius",
          at: new Date(),
        })
    ).rejects.toThrow("Invalid unit")
  })

  test("reads telemetry back through the same typed channel that wrote it", async () => {
    const sixb = createTestSixb({
      id: "project-a",
      ontology: [Room, Thermostat],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })

    const temperature = sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature)
    for (const [index, value] of [21.5, 22, 22.5].entries()) {
      await temperature.append({
        value,
        unit: "degreeCelsius",
        at: new Date(Date.UTC(2026, 0, 1, 10, index)),
      })
    }

    // Before `history()`, reading this back meant leaving the typed surface for
    // `sixb.storage.timeseries` — telemetry was the only write-only ontology data.
    // Chronological by default, matching `storage.timeseries.getHistoryBatch`.
    const points = await temperature.history()
    expect(points.map((point) => point.value)).toEqual([21.5, 22, 22.5])
    expect(points[0]?.unit).toBe("degreeCelsius")
    expect(points[0]?.at).toEqual(new Date("2026-01-01T10:00:00.000Z"))

    expect((await temperature.history({ order: "desc" })).map((point) => point.value)).toEqual([
      22.5, 22, 21.5,
    ])
    expect((await temperature.history({ limit: 2 })).map((point) => point.value)).toEqual([
      21.5, 22,
    ])
    expect(
      (
        await temperature.history({
          from: new Date("2026-01-01T10:01:00.000Z"),
          to: new Date("2026-01-01T10:01:30.000Z"),
        })
      ).map((point) => point.value)
    ).toEqual([22])

    // An empty series reads as an empty page, not a throw.
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    expect(
      await sixb.objects(Room).byId("room:102").telemetry(Room.p.currentTemperature).history()
    ).toEqual([])
  })

  test("emits typed events and projects through the runtime dependencies", async () => {
    const runtimeDeps = createTestRuntimeDeps()

    const sixb = createTestSixb({
      id: "project-a",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: {
        id: "room:101",
        externalId: "RM-101",
        name: "Conference 101",
      },
    })

    await sixb
      .objects(Room)
      .byId("room:101")
      .telemetry(Room.p.currentTemperature)
      .append({
        value: 22.4,
        unit: "degreeCelsius",
        at: new Date("2026-01-01T10:00:00.000Z"),
      })

    const tstat = await sixb.objects(Thermostat).upsert({
      properties: {
        id: "tstat:abc",
        externalId: "device-123",
        name: "Tstat 101",
      },
    })

    await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .link(Room.l.hasThermostat, tstat, {
          properties: { installedBy: "tech-a" },
        })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .link(Room.l.hasThermostat, tstat, {
          properties: { installedBy: "tech-a" },
        })
    ).rejects.toThrow("does not define link properties")

    // Latest telemetry is part of effective object state, so appending a point also updates the
    // object it belongs to. Facts of one commit are claimed in commit-ordinal order, so a link
    // never arrives before the object it references.
    const stream = await sixb.events.read()
    expect([...stream].map((event) => event.type)).toEqual([
      "object.created",
      "object.updated",
      "telemetry.appended",
      "object.created",
      "link.created",
    ])
    expect(Object.fromEntries(stream.map((event) => [event.type, event.topic]))).toEqual({
      "object.created": "objects",
      "object.updated": "objects",
      "telemetry.appended": "telemetry",
      "link.created": "links",
    })

    const latest = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "currentTemperature",
    })

    expect(latest?.value).toBe(22.4)
    expect(latest?.unit).toBe("degreeCelsius")

    const projectedRoom = await runtimeDeps.storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })

    expect(projectedRoom?.properties.currentTemperature).toBe(22.4)

    const links = await runtimeDeps.storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      linkId: "hasThermostat",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.targetTypeId).toBe("Thermostat")
    expect(links[0]?.targetId).toBe("tstat:abc")
  })

  test("lists objects with pagination and filters", async () => {
    const sixb = createTestSixb({
      id: "list-test",
      ontology: [Room, Thermostat],
      ...createTestRuntimeDeps(),
    })

    // Create multiple rooms
    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:103", externalId: "RM-103", name: "Conference 103" },
    })
    await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:abc", externalId: "device-123", name: "Tstat 101" },
    })

    // Test type-scoped list
    const rooms = await sixb.objects(Room).list({ limit: 2 })
    expect(rooms.objects).toHaveLength(2)
    expect(rooms.total).toBe(3)
    expect(rooms.hasMore).toBe(true)

    // Test pagination
    const page2 = await sixb.objects(Room).list({ limit: 2, offset: 2 })
    expect(page2.objects).toHaveLength(1)
    expect(page2.hasMore).toBe(false)

    // Test id prefix filter
    const prefixRooms = await sixb.objects(Room).list({ idPrefix: "room:10" })
    expect(prefixRooms.objects).toHaveLength(3)

    // Test type-safe where filter
    const filteredRooms = await sixb
      .objects(Room)
      .query()
      .where((r) => r.p.externalId.eq("RM-101"))
      .list()
    expect(filteredRooms.objects).toHaveLength(1)
    expect(filteredRooms.objects[0]?.properties.externalId).toBe("RM-101")

    const groupedFilterRooms = await sixb
      .objects(Room)
      .query()
      .where((r) => r.and(r.p.externalId.eq("RM-101"), r.p.name.eq("Conference 101")))
      .list()
    expect(groupedFilterRooms.objects).toHaveLength(1)
    expect(groupedFilterRooms.objects[0]?.properties.externalId).toBe("RM-101")

    const nonEqualityRooms = await sixb
      .objects(Room)
      .query()
      .where((r) => r.p.name.neq("Conference 103"))
      .list()
    expect(nonEqualityRooms.objects).toHaveLength(2)

    // Test global list
    const allObjects = await sixb.objects.list({ limit: 10 })
    expect(allObjects.objects).toHaveLength(4)

    // Test global list with type filter
    const roomObjects = await sixb.objects.list({ objectTypeIds: ["Room"], limit: 10 })
    expect(roomObjects.objects).toHaveLength(3)

    await expect(sixb.objects.list({ objectTypeIds: ["room"] })).rejects.toThrow(
      "Unknown object type 'room'. Object type IDs are case-sensitive."
    )

    // Test ordering
    const orderedByKey = await sixb.objects(Room).list({
      orderBy: "primaryId",
      order: "asc",
      limit: 10,
    })
    expect(orderedByKey.objects[0]?.primaryId).toBe("room:101")
    expect(orderedByKey.objects[2]?.primaryId).toBe("room:103")
  })

  test("appendTelemetryBatch writes multiple objects and properties in one call", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "batch-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })

    const now = new Date("2026-03-01T12:00:00.000Z")

    await sixb.objects(Room).appendTelemetryBatch([
      {
        id: "room:101",
        properties: {
          currentTemperature: { value: 22.5, unit: "degreeCelsius" },
        },
        at: now,
      },
      {
        id: "room:102",
        properties: {
          currentTemperature: { value: 19.8, unit: "degreeCelsius" },
        },
        at: now,
      },
    ])

    // Verify timeseries storage
    const latest101 = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "batch-test",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "currentTemperature",
    })
    expect(latest101?.value).toBe(22.5)
    expect(latest101?.unit).toBe("degreeCelsius")

    const latest102 = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "batch-test",
      objectTypeId: "Room",
      objectId: "room:102",
      propertyId: "currentTemperature",
    })
    expect(latest102?.value).toBe(19.8)

    // Verify object storage projection
    const room101 = await runtimeDeps.storage.objects.getByPrimaryId({
      projectId: "batch-test",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(room101?.properties.currentTemperature).toBe(22.5)

    const room102 = await runtimeDeps.storage.objects.getByPrimaryId({
      projectId: "batch-test",
      objectTypeId: "Room",
      primaryId: "room:102",
    })
    expect(room102?.properties.currentTemperature).toBe(19.8)

    // Verify all telemetry events were written
    const events = await sixb.events.read({
      types: ["telemetry.appended"],
    })
    expect(events).toHaveLength(2)
  })

  test("canonicalizes exact decimal telemetry before persistence", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({ id: "decimal-telemetry-test", ontology: [Room], ...runtimeDeps })
    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })

    await sixb.objects(Room).appendTelemetryBatch([
      {
        id: "room:101",
        properties: { exactReading: "+009007199254740993.0100" as never },
      },
    ])

    const latest = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "decimal-telemetry-test",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "exactReading",
    })
    expect(latest?.value).toBe("9007199254740993.01")
  })

  test("late-arriving telemetry does not replace the object latest value", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "late-telemetry-test",
      ontology: [Room],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })

    await sixb.objects(Room).appendTelemetryBatch([
      {
        id: "room:101",
        properties: { currentTemperature: { value: 23, unit: "degreeCelsius" } },
        at: new Date("2026-03-02T12:00:00.000Z"),
      },
    ])

    await sixb.objects(Room).appendTelemetryBatch([
      {
        id: "room:101",
        properties: { currentTemperature: { value: 21, unit: "degreeCelsius" } },
        at: new Date("2026-03-01T12:00:00.000Z"),
      },
    ])

    const room = await runtimeDeps.storage.objects.getByPrimaryId({
      projectId: "late-telemetry-test",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(room?.properties.currentTemperature).toBe(23)

    const history = await runtimeDeps.storage.timeseries.getHistory({
      projectId: "late-telemetry-test",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "currentTemperature",
    })
    expect(history.map((point) => point.value)).toEqual([21, 23])
  })

  test("appendTelemetryBatch validates all inputs before writing", async () => {
    const sixb = createTestSixb({
      id: "batch-validate-test",
      ontology: [Room],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })

    // Non-existent object should fail
    await expect(
      sixb.objects(Room).appendTelemetryBatch([
        {
          id: "room:999",
          properties: { currentTemperature: { value: 22.5, unit: "degreeCelsius" } },
        },
      ])
    ).rejects.toBeInstanceOf(ObjectNotFoundError)
    await expect(
      sixb.objects(Room).appendTelemetryBatch([
        {
          id: "room:999",
          properties: { currentTemperature: { value: 22.5, unit: "degreeCelsius" } },
        },
      ])
    ).rejects.toThrow("Object not found")

    // Invalid unit should fail
    await expect(
      sixb.objects(Room).appendTelemetryBatch([
        {
          id: "room:101",
          properties: {
            currentTemperature: { value: 22.5, unit: "millibar" as unknown as "degreeCelsius" },
          },
        },
      ])
    ).rejects.toBeInstanceOf(MaterializationValidationError)
    await expect(
      sixb.objects(Room).appendTelemetryBatch([
        {
          id: "room:101",
          properties: {
            currentTemperature: { value: 22.5, unit: "millibar" as unknown as "degreeCelsius" },
          },
        },
      ])
    ).rejects.toThrow("Invalid unit")
  })

  test("removes a link via unlink", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "unlink-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:abc", externalId: "device-123", name: "Tstat 101" },
    })

    const tstat = { objectTypeId: "Thermostat" as const, primaryId: "tstat:abc" }
    await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

    // Verify link exists
    const linksBefore = await sixb.objects(Room).byId("room:101").listLinks(Room.l.hasThermostat)
    expect(linksBefore).toHaveLength(1)

    // Unlink
    await sixb.objects(Room).byId("room:101").unlink(Room.l.hasThermostat, tstat)

    // Verify link removed
    const linksAfter = await sixb.objects(Room).byId("room:101").listLinks(Room.l.hasThermostat)
    expect(linksAfter).toHaveLength(0)

    // Verify link.deleted event was emitted
    const events = await sixb.events.read({
      types: ["link.deleted"],
    })
    expect(events).toHaveLength(1)
  })

  test("rejects plain link id objects in listLinks", async () => {
    const sixb = createTestSixb({
      id: "list-links-token-test",
      ontology: [Room, Thermostat],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .listLinks({ id: "hasThermostat" } as unknown as typeof Room.l.hasThermostat)
    ).rejects.toThrow("Expected a link token from Room.l.<linkId>")
  })

  test("removes a link via ObjectSet.removeLink", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "remove-link-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:201", externalId: "RM-201", name: "Room 201" },
    })
    await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:xyz", externalId: "device-xyz", name: "Tstat XYZ" },
    })

    await sixb.objects(Room).upsertLink({
      sourceId: "room:201",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:xyz",
    })

    const linksBefore = await runtimeDeps.storage.objects.listLinks({
      projectId: "remove-link-test",
      objectTypeId: "Room",
      objectId: "room:201",
    })
    expect(linksBefore).toHaveLength(1)

    await sixb.objects(Room).removeLink({
      sourceId: "room:201",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:xyz",
    })

    const linksAfter = await runtimeDeps.storage.objects.listLinks({
      projectId: "remove-link-test",
      objectTypeId: "Room",
      objectId: "room:201",
    })
    expect(linksAfter).toHaveLength(0)
  })

  test("requests action via ObjectByKeyHandle.requestAction", async () => {
    const ActionType = defineObjectType({
      id: "ActionDevice",
      name: "Action Device",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { required: true }),
      ],
    })
    const reboot = defineAction("reboot")
      .on(ActionType)
      .params({ force: optional(param("boolean")) })
      .writeback(async () => {})

    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "bykey-action-test",
      ontology: [ActionType],
      actions: [reboot],
      ...runtimeDeps,
    })

    await sixb.objects(ActionType).upsert({
      properties: { id: "dev:1", name: "Device 1" },
    })

    await sixb
      .objects(ActionType)
      .byId("dev:1")
      .requestAction({
        actionId: "reboot",
        params: { force: true },
      })

    const events = await sixb.events.read({
      types: ["action.requested"],
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("action.requested")
    if (events[0].type === "action.requested") {
      expect(events[0].payload.actionId).toBe("reboot")
      expect(events[0].payload.params.force).toBe(true)
    }
  })

  test("supports typed API and direct runtime access for server usage", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "server-api-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    expect(sixb.execution.projectId).toBe("server-api-test")
    expect(
      sixb.objects
        .listTypes()
        .map((objectType) => objectType.id)
        .sort()
    ).toEqual(["Room", "Thermostat"])

    await sixb.objects(Room).upsert({
      properties: { id: "room:900", externalId: "RM-900", name: "Lab 900" },
    })

    await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:900", externalId: "TS-900", name: "Thermostat 900" },
    })

    await sixb.objects(Room).upsertLink({
      sourceId: "room:900",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:900",
    })

    await sixb.objects(Room).appendTelemetryBatch([
      {
        id: "room:900",
        properties: { currentTemperature: { value: 21.2, unit: "degreeCelsius" } },
        at: new Date("2026-02-01T10:00:00.000Z"),
      },
    ])

    const room = await sixb.objects(Room).get("room:900")
    expect(room?.properties.currentTemperature).toBe(21.2)

    const links = await sixb.objects(Room).byId("room:900").listLinks(Room.l.hasThermostat)
    expect(links).toHaveLength(1)

    const latest = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "server-api-test",
      objectTypeId: "Room",
      objectId: "room:900",
      propertyId: "currentTemperature",
    })
    expect(latest?.value).toBe(21.2)

    const events = await sixb.events.read({
      topics: ["objects", "telemetry", "links"],
    })
    expect(events.length).toBeGreaterThanOrEqual(4)
  })
  describe("valueTypeRef validation", () => {
    const TemperatureReading = defineValueType({
      id: "bsh:TemperatureReading",
      name: "TemperatureReading",
      schema: {
        type: "object",
        properties: {
          value: { required: true, schema: "double" },
          unit: {
            required: true,
            schema: { type: "enum", valueType: "string", values: ["C", "F", "K"] },
          },
        },
      },
    })

    const Sensor = defineObjectType({
      id: "Sensor",
      name: "Sensor",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { required: true }),
        prop("reading", valueTypeRef(TemperatureReading)),
      ],
    })

    test("auto-discovers ValueTypes from ObjectType properties", async () => {
      // Pass only the ObjectType — no explicit OntologyDocumentInput
      const sixb = createTestSixb({ ontology: [Sensor], ...createTestRuntimeDeps() })

      const sensor = await sixb.objects.upsert("Sensor", {
        id: "sensor:1",
        name: "Temp-1",
        reading: { value: 22.5, unit: "C" },
      })

      expect(sensor.properties.reading).toEqual({ value: 22.5, unit: "C" })
    })

    test("rejects values that do not conform to the ValueType schema", async () => {
      const sixb = createTestSixb({ ontology: [Sensor], ...createTestRuntimeDeps() })

      await expect(
        sixb.objects.upsert("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: "hot", unit: "C" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      await expect(
        sixb.objects.upsert("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: "hot", unit: "C" },
        })
      ).rejects.toThrow("must be numeric")
    })

    test("rejects enum values outside the allowed set", async () => {
      const sixb = createTestSixb({ ontology: [Sensor], ...createTestRuntimeDeps() })

      await expect(
        sixb.objects.upsert("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: 22.5, unit: "Rankine" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      await expect(
        sixb.objects.upsert("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: 22.5, unit: "Rankine" },
        })
      ).rejects.toThrow("must be one of")
    })

    test("explicit ValueTypes take priority over auto-discovered ones", () => {
      const explicitVT = defineValueType({
        id: "bsh:TemperatureReading",
        name: "Custom Temperature Reading",
        schema: TemperatureReading.schema,
        semanticType: "Temperature",
      })

      const ontologyDoc = defineOntology({
        id: "test-ontology",
        version: "1.0.0",
        objectTypes: [Sensor],
        valueTypes: [explicitVT],
      })

      // Should not throw "Duplicate value type id"
      const sixb = createTestSixb({ ontology: [ontologyDoc], ...createTestRuntimeDeps() })
      expect(sixb.objects.listTypes()).toHaveLength(1)
    })

    test("throws for valueTypeRef without _resolved and no explicit registration", () => {
      const Orphan = defineObjectType({
        id: "Orphan",
        name: "Orphan",
        properties: [
          prop("id", "string", { required: true, primary: true }),
          prop("name", "string", { required: true }),
          prop("data", valueTypeRef("unknown:MissingShape")),
        ],
      })

      const sixb = createTestSixb({ ontology: [Orphan], ...createTestRuntimeDeps() })

      expect(
        sixb.objects.upsert("Orphan", {
          id: "orphan:1",
          name: "test",
          data: { foo: "bar" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      expect(
        sixb.objects.upsert("Orphan", {
          id: "orphan:1",
          name: "test",
          data: { foo: "bar" },
        })
      ).rejects.toThrow("Unknown valueTypeRef")
    })
  })

  test("supports id-based runtime APIs for server usage", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "server-api-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    expect(sixb.execution.projectId).toBe("server-api-test")
    expect(
      sixb.objects
        .listTypes()
        .map((objectType) => objectType.id)
        .sort()
    ).toEqual(["Room", "Thermostat"])

    await sixb.objects(Room).upsert({
      properties: { id: "room:900", externalId: "RM-900", name: "Lab 900" },
    })

    await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:900", externalId: "TS-900", name: "Thermostat 900" },
    })

    await sixb.objects(Room).upsertLink({
      sourceId: "room:900",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:900",
    })

    await sixb.objects(Room).appendTelemetryBatch([
      {
        id: "room:900",
        properties: { currentTemperature: { value: 21.2, unit: "degreeCelsius" } },
        at: new Date("2026-02-01T10:00:00.000Z"),
      },
    ])

    const room = await sixb.objects(Room).get("room:900")
    expect(room?.properties.currentTemperature).toBe(21.2)

    const links = await sixb.objects(Room).byId("room:900").listLinks(Room.l.hasThermostat)
    expect(links).toHaveLength(1)

    const latest = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "server-api-test",
      objectTypeId: "Room",
      objectId: "room:900",
      propertyId: "currentTemperature",
    })
    expect(latest?.value).toBe(21.2)

    const events = await sixb.events.read({
      topics: ["objects", "telemetry", "links"],
    })
    expect(events.length).toBeGreaterThanOrEqual(4)
  })
})
