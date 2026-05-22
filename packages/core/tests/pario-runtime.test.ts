import { describe, expect, test } from "bun:test"
import {
  actionParam,
  defineAction,
  defineObjectType,
  defineOntology,
  defineValueType,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryQueues,
  link,
  ObjectNotFoundError,
  OntologyValidationError,
  Pario,
  prop,
  valueTypeRef,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
    prop("currentTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
  links: [link("hasThermostat", "Thermostat", { cardinality: "one" })],
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

describe("Pario runtime", () => {
  test("upserts an object using object-type tokens", async () => {
    const pario = new Pario({ ontology: [Room], ...createTestRuntimeDeps() })

    const room = await pario.objects(Room).upsert({
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

    const found = await pario.objects(Room).findFirst({
      where: (r) => r.p.externalId.eq("RM-101"),
    })

    expect(found?.primaryId).toBe("room:101")

    await expect(
      pario.objects(Room).upsert({
        properties: {
          id: "room:invalid",
          externalId: "RM-INVALID",
          name: 101 as unknown as string,
        },
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      pario.objects(Room).upsert({
        properties: {
          id: "room:invalid",
          externalId: "RM-INVALID",
          name: 101 as unknown as string,
        },
      })
    ).rejects.toThrow("must be a string")
  })

  test("exposes configured lakeStorage on the runtime", () => {
    const lakeStorage = new InMemoryLakeStorage()
    const pario = new Pario({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      lakeStorage,
    })

    expect(pario.lakeStorage).toBe(lakeStorage)
  })

  test("exposes the configured blobStorage on the runtime", () => {
    const blobStorage = new InMemoryBlobStorage()
    const lakeStorage = new InMemoryLakeStorage()
    const pario = new Pario({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      lakeStorage,
      blobStorage,
    })

    expect(pario.blobStorage).toBe(blobStorage)
  })

  test("upserts objects with fileRef properties", async () => {
    const pario = new Pario({ ontology: [Document], ...createTestRuntimeDeps() })
    const file = await pario.blobStorage.put({
      body: new TextEncoder().encode("document bytes"),
      fileName: "document.pdf",
      mediaType: "application/pdf",
    })

    const document = await pario.objects(Document).upsert({
      properties: {
        id: "doc:1",
        file,
      },
    })

    expect(document.properties.file).toEqual(file)

    await expect(
      pario.objects(Document).upsert({
        properties: {
          id: "doc:2",
          file: { blobId: "blob_missing" } as unknown as typeof file,
        },
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      pario.objects(Document).upsert({
        properties: {
          id: "doc:2",
          file: { blobId: "blob_missing" } as unknown as typeof file,
        },
      })
    ).rejects.toThrow("must be a fileRef")
  })

  test("exposes configured queues on the runtime", () => {
    const queues = new InMemoryQueues()
    const pario = new Pario({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      queues,
    })

    expect(pario.queues).toBe(queues)
  })

  test("exposes projection run storage from in-memory storage", () => {
    const pario = new Pario({ ontology: [Room], ...createTestRuntimeDeps() })

    expect(pario.storage.projectionRuns).toBeDefined()
  })

  test("appends telemetry with unit validation", async () => {
    const pario = new Pario({ ontology: [Room], ...createTestRuntimeDeps() })

    await pario.objects(Room).upsert({
      properties: {
        id: "room:101",
        externalId: "RM-101",
        name: "Conference 101",
      },
    })

    await pario.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
      value: 22.4,
      unit: "degreeCelsius",
      at: new Date(),
    })

    await expect(
      pario
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
      pario
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
      pario
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
      pario
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

    const pario = new Pario({
      id: "project-a",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await pario.objects(Room).upsert({
      properties: {
        id: "room:101",
        externalId: "RM-101",
        name: "Conference 101",
      },
    })

    await pario
      .objects(Room)
      .byId("room:101")
      .telemetry(Room.p.currentTemperature)
      .append({
        value: 22.4,
        unit: "degreeCelsius",
        at: new Date("2026-01-01T10:00:00.000Z"),
      })

    const tstat = await pario.objects(Thermostat).upsert({
      properties: {
        id: "tstat:abc",
        externalId: "device-123",
        name: "Tstat 101",
      },
    })

    await pario.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

    await expect(
      pario
        .objects(Room)
        .byId("room:101")
        .link(Room.l.hasThermostat, tstat, {
          properties: { installedBy: "tech-a" },
        })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      pario
        .objects(Room)
        .byId("room:101")
        .link(Room.l.hasThermostat, tstat, {
          properties: { installedBy: "tech-a" },
        })
    ).rejects.toThrow("does not define link properties")

    const stream = await pario.events.read()
    expect(stream).toHaveLength(4)
    expect(stream[0]?.type).toBe("object.upserted")
    expect(stream[0]?.topic).toBe("objects")
    expect(stream[1]?.type).toBe("telemetry.appended")
    expect(stream[1]?.topic).toBe("telemetry")
    expect(stream[3]?.type).toBe("link.upserted")
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
      sourceTypeId: "Room",
      sourceId: "room:101",
      linkId: "hasThermostat",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.targetTypeId).toBe("Thermostat")
    expect(links[0]?.targetId).toBe("tstat:abc")
  })

  test("lists objects with pagination and filters", async () => {
    const pario = new Pario({
      id: "list-test",
      ontology: [Room, Thermostat],
      ...createTestRuntimeDeps(),
    })

    // Create multiple rooms
    await pario.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await pario.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    await pario.objects(Room).upsert({
      properties: { id: "room:103", externalId: "RM-103", name: "Conference 103" },
    })
    await pario.objects(Thermostat).upsert({
      properties: { id: "tstat:abc", externalId: "device-123", name: "Tstat 101" },
    })

    // Test type-scoped list
    const rooms = await pario.objects(Room).list({ limit: 2 })
    expect(rooms.objects).toHaveLength(2)
    expect(rooms.total).toBe(3)
    expect(rooms.hasMore).toBe(true)

    // Test pagination
    const page2 = await pario.objects(Room).list({ limit: 2, offset: 2 })
    expect(page2.objects).toHaveLength(1)
    expect(page2.hasMore).toBe(false)

    // Test id prefix filter
    const prefixRooms = await pario.objects(Room).list({ idPrefix: "room:10" })
    expect(prefixRooms.objects).toHaveLength(3)

    // Test type-safe where filter
    const filteredRooms = await pario.objects(Room).list({
      where: (r) => r.p.externalId.eq("RM-101"),
    })
    expect(filteredRooms.objects).toHaveLength(1)
    expect(filteredRooms.objects[0]?.properties.externalId).toBe("RM-101")

    // Test global list
    const allObjects = await pario.list({ limit: 10 })
    expect(allObjects.objects).toHaveLength(4)

    // Test global list with type filter
    const roomObjects = await pario.list({ objectTypeIds: ["Room"], limit: 10 })
    expect(roomObjects.objects).toHaveLength(3)

    // Test ordering
    const orderedByKey = await pario.objects(Room).list({
      orderBy: "primaryId",
      order: "asc",
      limit: 10,
    })
    expect(orderedByKey.objects[0]?.primaryId).toBe("room:101")
    expect(orderedByKey.objects[2]?.primaryId).toBe("room:103")
  })

  test("appendTelemetryBatch writes multiple objects and properties in one call", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "batch-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await pario.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })

    const now = new Date("2026-03-01T12:00:00.000Z")

    await pario.objects(Room).appendTelemetryBatch([
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
    const events = await pario.events.read({
      types: ["telemetry.appended"],
    })
    expect(events).toHaveLength(2)
  })

  test("appendTelemetryBatch validates all inputs before writing", async () => {
    const pario = new Pario({
      id: "batch-validate-test",
      ontology: [Room],
      ...createTestRuntimeDeps(),
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })

    // Non-existent object should fail
    await expect(
      pario.objects(Room).appendTelemetryBatch([
        {
          id: "room:999",
          properties: { currentTemperature: { value: 22.5, unit: "degreeCelsius" } },
        },
      ])
    ).rejects.toBeInstanceOf(ObjectNotFoundError)
    await expect(
      pario.objects(Room).appendTelemetryBatch([
        {
          id: "room:999",
          properties: { currentTemperature: { value: 22.5, unit: "degreeCelsius" } },
        },
      ])
    ).rejects.toThrow("Object not found")

    // Invalid unit should fail
    await expect(
      pario.objects(Room).appendTelemetryBatch([
        {
          id: "room:101",
          properties: {
            currentTemperature: { value: 22.5, unit: "millibar" as unknown as "degreeCelsius" },
          },
        },
      ])
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      pario.objects(Room).appendTelemetryBatch([
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
    const pario = new Pario({
      id: "unlink-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await pario.objects(Thermostat).upsert({
      properties: { id: "tstat:abc", externalId: "device-123", name: "Tstat 101" },
    })

    const tstat = { objectTypeId: "Thermostat" as const, primaryId: "tstat:abc" }
    await pario.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

    // Verify link exists
    const linksBefore = await pario.objects(Room).byId("room:101").listLinks(Room.l.hasThermostat)
    expect(linksBefore).toHaveLength(1)

    // Unlink
    await pario.objects(Room).byId("room:101").unlink(Room.l.hasThermostat, tstat)

    // Verify link removed
    const linksAfter = await pario.objects(Room).byId("room:101").listLinks(Room.l.hasThermostat)
    expect(linksAfter).toHaveLength(0)

    // Verify link.removed event was emitted
    const events = await pario.events.read({
      types: ["link.removed"],
    })
    expect(events).toHaveLength(1)
  })

  test("removes a link via ObjectSet.removeLink", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "remove-link-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:201", externalId: "RM-201", name: "Room 201" },
    })
    await pario.objects(Thermostat).upsert({
      properties: { id: "tstat:xyz", externalId: "device-xyz", name: "Tstat XYZ" },
    })

    await pario.objects(Room).upsertLink({
      sourceId: "room:201",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:xyz",
    })

    const linksBefore = await runtimeDeps.storage.objects.listLinks({
      projectId: "remove-link-test",
      sourceTypeId: "Room",
      sourceId: "room:201",
    })
    expect(linksBefore).toHaveLength(1)

    await pario.objects(Room).removeLink({
      sourceId: "room:201",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:xyz",
    })

    const linksAfter = await runtimeDeps.storage.objects.listLinks({
      projectId: "remove-link-test",
      sourceTypeId: "Room",
      sourceId: "room:201",
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
      .target(ActionType)
      .params({ force: actionParam("boolean") })
      .run(async () => {})

    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "bykey-action-test",
      ontology: [ActionType],
      actions: [reboot],
      ...runtimeDeps,
    })

    await pario.objects(ActionType).upsert({
      properties: { id: "dev:1", name: "Device 1" },
    })

    await pario
      .objects(ActionType)
      .byId("dev:1")
      .requestAction({
        actionId: "reboot",
        params: { force: true },
      })

    const events = await pario.events.read({
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
    const pario = new Pario({
      id: "server-api-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    expect(pario.id).toBe("server-api-test")
    expect(
      pario
        .listObjectTypes()
        .map((objectType) => objectType.id)
        .sort()
    ).toEqual(["Room", "Thermostat"])

    await pario.objects(Room).upsert({
      properties: { id: "room:900", externalId: "RM-900", name: "Lab 900" },
    })

    await pario.objects(Thermostat).upsert({
      properties: { id: "tstat:900", externalId: "TS-900", name: "Thermostat 900" },
    })

    await pario.objects(Room).upsertLink({
      sourceId: "room:900",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:900",
    })

    await pario.objects(Room).appendTelemetryBatch([
      {
        id: "room:900",
        properties: { currentTemperature: { value: 21.2, unit: "degreeCelsius" } },
        at: new Date("2026-02-01T10:00:00.000Z"),
      },
    ])

    const room = await pario.objects(Room).get("room:900")
    expect(room?.properties.currentTemperature).toBe(21.2)

    const links = await pario.objects(Room).byId("room:900").listLinks(Room.l.hasThermostat)
    expect(links).toHaveLength(1)

    const latest = await pario.storage.timeseries.getLatest({
      projectId: "server-api-test",
      objectTypeId: "Room",
      objectId: "room:900",
      propertyId: "currentTemperature",
    })
    expect(latest?.value).toBe(21.2)

    const events = await pario.events.read({
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
      const pario = new Pario({ ontology: [Sensor], ...createTestRuntimeDeps() })

      const sensor = await pario.upsertObject("Sensor", {
        id: "sensor:1",
        name: "Temp-1",
        reading: { value: 22.5, unit: "C" },
      })

      expect(sensor.properties.reading).toEqual({ value: 22.5, unit: "C" })
    })

    test("rejects values that do not conform to the ValueType schema", async () => {
      const pario = new Pario({ ontology: [Sensor], ...createTestRuntimeDeps() })

      await expect(
        pario.upsertObject("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: "hot", unit: "C" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      await expect(
        pario.upsertObject("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: "hot", unit: "C" },
        })
      ).rejects.toThrow("must be numeric")
    })

    test("rejects enum values outside the allowed set", async () => {
      const pario = new Pario({ ontology: [Sensor], ...createTestRuntimeDeps() })

      await expect(
        pario.upsertObject("Sensor", {
          id: "sensor:bad",
          name: "Temp-bad",
          reading: { value: 22.5, unit: "Rankine" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      await expect(
        pario.upsertObject("Sensor", {
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
      const pario = new Pario({ ontology: [ontologyDoc], ...createTestRuntimeDeps() })
      expect(pario.listObjectTypes()).toHaveLength(1)
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

      const pario = new Pario({ ontology: [Orphan], ...createTestRuntimeDeps() })

      expect(
        pario.upsertObject("Orphan", {
          id: "orphan:1",
          name: "test",
          data: { foo: "bar" },
        })
      ).rejects.toBeInstanceOf(OntologyValidationError)
      expect(
        pario.upsertObject("Orphan", {
          id: "orphan:1",
          name: "test",
          data: { foo: "bar" },
        })
      ).rejects.toThrow("Unknown valueTypeRef")
    })
  })

  test("supports id-based runtime APIs for server usage", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "server-api-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    expect(pario.id).toBe("server-api-test")
    expect(
      pario
        .listObjectTypes()
        .map((objectType) => objectType.id)
        .sort()
    ).toEqual(["Room", "Thermostat"])

    await pario.objects(Room).upsert({
      properties: { id: "room:900", externalId: "RM-900", name: "Lab 900" },
    })

    await pario.objects(Thermostat).upsert({
      properties: { id: "tstat:900", externalId: "TS-900", name: "Thermostat 900" },
    })

    await pario.objects(Room).upsertLink({
      sourceId: "room:900",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:900",
    })

    await pario.objects(Room).appendTelemetryBatch([
      {
        id: "room:900",
        properties: { currentTemperature: { value: 21.2, unit: "degreeCelsius" } },
        at: new Date("2026-02-01T10:00:00.000Z"),
      },
    ])

    const room = await pario.objects(Room).get("room:900")
    expect(room?.properties.currentTemperature).toBe(21.2)

    const links = await pario.objects(Room).byId("room:900").listLinks(Room.l.hasThermostat)
    expect(links).toHaveLength(1)

    const latest = await pario.storage.timeseries.getLatest({
      projectId: "server-api-test",
      objectTypeId: "Room",
      objectId: "room:900",
      propertyId: "currentTemperature",
    })
    expect(latest?.value).toBe(21.2)

    const events = await pario.events.read({
      topics: ["objects", "telemetry", "links"],
    })
    expect(events.length).toBeGreaterThanOrEqual(4)
  })
})
