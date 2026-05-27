import { describe, expect, mock, test } from "bun:test"
import {
  defineObjectType,
  link,
  ObjectNotFoundError,
  OntologyValidationError,
  Pario,
  prop,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// ── Test fixtures ────────────────────────────────────────────

const Building = defineObjectType({
  id: "building",
  name: "Building",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const Room = defineObjectType({
  id: "room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("buildingRef", "string"),
  ],
  links: [
    link("inBuilding", Building, { cardinality: "one" }),
    link("hasSensors", "sensor", { cardinality: "many" }),
  ],
})

const Sensor = defineObjectType({
  id: "sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

// ── upsertObjectBatch ────────────────────────────────────────

describe("upsertObjectBatch", () => {
  test("happy path — 3 objects, all ok", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    const results = await pario.upsertObjectBatch("room", [
      { properties: { id: "r1", name: "Kitchen" } },
      { properties: { id: "r2", name: "Bedroom" } },
      { properties: { id: "r3", name: "Bathroom" } },
    ])

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.ok)).toBe(true)

    if (results[0].ok) expect(results[0].value.primaryId).toBe("r1")
    if (results[1].ok) expect(results[1].value.primaryId).toBe("r2")
    if (results[2].ok) expect(results[2].value.primaryId).toBe("r3")

    // Verify storage
    const r1 = await deps.storage.objects.getByPrimaryId({
      projectId: pario.id,
      objectTypeId: "room",
      primaryId: "r1",
    })
    expect(r1?.properties.name).toBe("Kitchen")
  })

  test("partial failure — mix valid/invalid", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    const results = await pario.upsertObjectBatch("room", [
      { properties: { id: "r1", name: "Kitchen" } },
      { properties: { id: "r2", name: 12345 } }, // invalid type for "name"
      { properties: { id: "r3", name: "Bathroom" } },
    ])

    expect(results).toHaveLength(3)
    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(false)
    expect(results[2].ok).toBe(true)

    if (!results[1].ok) {
      expect(results[1].error).toBeInstanceOf(Error)
    }
  })

  test("all fail — no events created", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    const results = await pario.upsertObjectBatch("room", [
      { properties: { id: "r1" } }, // missing required "name"
      { properties: { id: "r2" } }, // missing required "name"
    ])

    expect(results).toHaveLength(2)
    expect(results.every((r) => !r.ok)).toBe(true)

    // No events should have been created
    const events = await pario.events.read({ types: ["object.upserted"] })
    expect(events).toHaveLength(0)
  })

  test("empty batch returns empty array", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    const results = await pario.upsertObjectBatch("room", [])
    expect(results).toEqual([])
  })

  test("merge with existing object", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    // Pre-create
    await pario.upsertObject("room", { id: "r1", name: "Old Name" })

    const results = await pario.upsertObjectBatch("room", [
      { properties: { id: "r1", name: "New Name" } },
    ])

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)

    const obj = await deps.storage.objects.getByPrimaryId({
      projectId: pario.id,
      objectTypeId: "room",
      primaryId: "r1",
    })
    expect(obj?.properties.name).toBe("New Name")
  })

  test("single events.append call", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })
    const originalAppend = pario.events.append.bind(pario.events)
    const appendSpy = mock(originalAppend)
    pario.events.append = appendSpy

    await pario.upsertObjectBatch("room", [
      { properties: { id: "r1", name: "A" } },
      { properties: { id: "r2", name: "B" } },
      { properties: { id: "r3", name: "C" } },
    ])

    // Should be exactly 1 events.append call for all 3 objects
    expect(appendSpy).toHaveBeenCalledTimes(1)
  })
})

// ── upsertLinkBatch ──────────────────────────────────────────

describe("upsertLinkBatch", () => {
  test("happy path — 3 links, all ok", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    // Pre-create objects
    await pario.upsertObject("room", { id: "r1", name: "Room 1" })
    await pario.upsertObject("room", { id: "r2", name: "Room 2" })
    await pario.upsertObject("sensor", { id: "s1", name: "Temp" })
    await pario.upsertObject("sensor", { id: "s2", name: "Humidity" })

    const results = await pario.upsertLinkBatch([
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "hasSensors",
        target: { targetTypeId: "sensor", targetId: "s1" },
      },
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "hasSensors",
        target: { targetTypeId: "sensor", targetId: "s2" },
      },
      {
        objectTypeId: "room",
        sourceId: "r2",
        linkId: "hasSensors",
        target: { targetTypeId: "sensor", targetId: "s1" },
      },
    ])

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.ok)).toBe(true)

    const links = await deps.storage.objects.listLinks({
      projectId: pario.id,
      objectTypeId: "room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links).toHaveLength(2)
  })

  test("ObjectNotFoundError per-item for missing source/target", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    // Only create the sensor, not the room
    await pario.upsertObject("sensor", { id: "s1", name: "Temp" })
    await pario.upsertObject("room", { id: "r1", name: "Room 1" })

    const results = await pario.upsertLinkBatch([
      {
        objectTypeId: "room",
        sourceId: "missing-room",
        linkId: "hasSensors",
        target: { targetTypeId: "sensor", targetId: "s1" },
      },
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "hasSensors",
        target: { targetTypeId: "sensor", targetId: "missing-sensor" },
      },
    ])

    expect(results).toHaveLength(2)

    expect(results[0].ok).toBe(false)
    if (!results[0].ok) {
      expect(results[0].error).toBeInstanceOf(ObjectNotFoundError)
      expect(results[0].error.message).toContain("Source object not found")
    }

    expect(results[1].ok).toBe(false)
    if (!results[1].ok) {
      expect(results[1].error).toBeInstanceOf(ObjectNotFoundError)
      expect(results[1].error.message).toContain("Target object not found")
    }
  })

  test("cardinality violation per-item", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    await pario.upsertObject("building", { id: "b1", name: "HQ" })
    await pario.upsertObject("building", { id: "b2", name: "Branch" })
    await pario.upsertObject("room", { id: "r1", name: "Room 1" })

    // Create existing cardinality:one link
    await pario.upsertLink("room", "r1", "inBuilding", {
      targetTypeId: "building",
      targetId: "b1",
    })

    const results = await pario.upsertLinkBatch([
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "inBuilding",
        target: { targetTypeId: "building", targetId: "b2" }, // violates cardinality:one
      },
    ])

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    if (!results[0].ok) {
      expect(results[0].error).toBeInstanceOf(OntologyValidationError)
    }
  })

  test("empty batch returns empty array", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })

    const results = await pario.upsertLinkBatch([])
    expect(results).toEqual([])
  })

  test("single events.append call", async () => {
    const deps = createTestRuntimeDeps()
    const pario = new Pario({ ontology: [Building, Room, Sensor], ...deps })
    const originalAppend = pario.events.append.bind(pario.events)
    const appendSpy = mock(originalAppend)
    pario.events.append = appendSpy

    await pario.upsertObject("room", { id: "r1", name: "Room 1" })
    await pario.upsertObject("sensor", { id: "s1", name: "Temp" })
    await pario.upsertObject("sensor", { id: "s2", name: "Humidity" })

    // Reset spy after setup objects
    appendSpy.mockClear()

    await pario.upsertLinkBatch([
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "hasSensors",
        target: { targetTypeId: "sensor", targetId: "s1" },
      },
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "hasSensors",
        target: { targetTypeId: "sensor", targetId: "s2" },
      },
    ])

    // Should be exactly 1 events.append call for all links
    expect(appendSpy).toHaveBeenCalledTimes(1)
  })
})
