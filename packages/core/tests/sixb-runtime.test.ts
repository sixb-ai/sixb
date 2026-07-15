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
  ObjectNotFoundError,
  type ObjectQuery,
  ObjectQueryPlanningError,
  OntologyValidationError,
  optional,
  param,
  prop,
  Sixb,
  valueTypeRef,
} from "../src"
import type { ObjectStorage, QueryObjectsInput, QueryObjectsResult } from "../src/storage"
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
  const originalQueryObjects = deps.storage.objects.queryObjects.bind(deps.storage.objects)
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

describe("Sixb runtime", () => {
  test("upserts an object using object-type tokens", async () => {
    const sixb = new Sixb({ ontology: [Room], ...createTestRuntimeDeps() })

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
    const sixb = new Sixb({ ontology: [SearchCustomer], ...createTestRuntimeDeps() })
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
    const sixb = new Sixb({ ontology: [Room], ...deps })

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
    const sixb = new Sixb({ ontology: [Room, Thermostat], ...createTestRuntimeDeps() })

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
    const sixb = new Sixb({ ontology: [Room], ...deps })

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
    const sixb = new Sixb({ ontology: [Room], ...deps })

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
    const sixb = new Sixb({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      lakeStorage,
    })

    expect(sixb.lakeStorage).toBe(lakeStorage)
  })

  test("exposes the configured blobStorage on the runtime", () => {
    const blobStorage = new InMemoryBlobStorage()
    const lakeStorage = new InMemoryLakeStorage()
    const sixb = new Sixb({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      lakeStorage,
      blobStorage,
    })

    expect(sixb.blobStorage).toBe(blobStorage)
  })

  test("upserts objects with fileRef properties", async () => {
    const sixb = new Sixb({ ontology: [Document], ...createTestRuntimeDeps() })
    const file = await sixb.blobStorage.put({
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
    const sixb = new Sixb({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      queues,
    })

    expect(sixb.queues).toBe(queues)
  })

  test("exposes projection run storage from in-memory storage", () => {
    const sixb = new Sixb({ ontology: [Room], ...createTestRuntimeDeps() })

    expect(sixb.storage.projectionRuns).toBeDefined()
  })

  test("appends telemetry with unit validation", async () => {
    const sixb = new Sixb({ ontology: [Room], ...createTestRuntimeDeps() })

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
    ).rejects.toBeInstanceOf(OntologyValidationError)
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
    ).rejects.toBeInstanceOf(OntologyValidationError)
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

  test("emits typed events and projects through the runtime dependencies", async () => {
    const runtimeDeps = createTestRuntimeDeps()

    const sixb = new Sixb({
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

    const stream = await sixb.events.read()
    expect(stream.map((event) => event.type)).toEqual([
      "object.created",
      "telemetry.appended",
      "object.created",
      "link.created",
    ])
    expect(stream[0]?.topic).toBe("objects")
    expect(stream[1]?.topic).toBe("telemetry")
    expect(stream[3]?.topic).toBe("links")

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
    const sixb = new Sixb({
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
    const allObjects = await sixb.list({ limit: 10 })
    expect(allObjects.objects).toHaveLength(4)

    // Test global list with type filter
    const roomObjects = await sixb.list({ objectTypeIds: ["Room"], limit: 10 })
    expect(roomObjects.objects).toHaveLength(3)

    await expect(sixb.list({ objectTypeIds: ["room"] })).rejects.toThrow(
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
    const sixb = new Sixb({
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

  test("late-arriving telemetry does not replace the object latest value", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
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
    const sixb = new Sixb({
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
    ).rejects.toBeInstanceOf(OntologyValidationError)
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
    const sixb = new Sixb({
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
    const sixb = new Sixb({
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
    const sixb = new Sixb({
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
    const sixb = new Sixb({
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
    const sixb = new Sixb({
      id: "server-api-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    expect(sixb.id).toBe("server-api-test")
    expect(
      sixb
        .listObjectTypes()
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

    const latest = await sixb.storage.timeseries.getLatest({
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
      const sixb = new Sixb({ ontology: [Sensor], ...createTestRuntimeDeps() })

      const sensor = await sixb.upsertObject("Sensor", {
        id: "sensor:1",
        name: "Temp-1",
        reading: { value: 22.5, unit: "C" },
      })

      expect(sensor.properties.reading).toEqual({ value: 22.5, unit: "C" })
    })

    test("rejects values that do not conform to the ValueType schema", async () => {
      const sixb = new Sixb({ ontology: [Sensor], ...createTestRuntimeDeps() })

      await expect(
        sixb.upsertObject("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: "hot", unit: "C" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      await expect(
        sixb.upsertObject("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: "hot", unit: "C" },
        })
      ).rejects.toThrow("must be numeric")
    })

    test("rejects enum values outside the allowed set", async () => {
      const sixb = new Sixb({ ontology: [Sensor], ...createTestRuntimeDeps() })

      await expect(
        sixb.upsertObject("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: 22.5, unit: "Rankine" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      await expect(
        sixb.upsertObject("Sensor", {
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
      const sixb = new Sixb({ ontology: [ontologyDoc], ...createTestRuntimeDeps() })
      expect(sixb.listObjectTypes()).toHaveLength(1)
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

      const sixb = new Sixb({ ontology: [Orphan], ...createTestRuntimeDeps() })

      expect(
        sixb.upsertObject("Orphan", {
          id: "orphan:1",
          name: "test",
          data: { foo: "bar" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      expect(
        sixb.upsertObject("Orphan", {
          id: "orphan:1",
          name: "test",
          data: { foo: "bar" },
        })
      ).rejects.toThrow("Unknown valueTypeRef")
    })
  })

  test("supports id-based runtime APIs for server usage", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "server-api-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    expect(sixb.id).toBe("server-api-test")
    expect(
      sixb
        .listObjectTypes()
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

    const latest = await sixb.storage.timeseries.getLatest({
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
