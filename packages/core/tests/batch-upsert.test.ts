import { describe, expect, mock, test } from "bun:test"
import {
  defineObjectType,
  type InMemoryBroker,
  link,
  ObjectNotFoundError,
  OntologyValidationError,
  prop,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps, waitFor } from "./test-runtime-deps"

/** Mutations publish durable outbox facts, so delivery is observed on the publication boundary. */
function spyPublishedFacts(broker: InMemoryBroker) {
  const publish = broker.append.bind(broker)
  const spy = mock(publish)
  broker.append = spy
  return spy
}

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
    link.ref("hasSensors", "sensor", { cardinality: "many" }),
  ],
})

const Sensor = defineObjectType({
  id: "sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const SeparatorTarget = defineObjectType({
  id: "separator",
  name: "Separator target",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const SeparatorSource = defineObjectType({
  id: "separator:source",
  name: "Separator source",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("target", SeparatorTarget)],
})

// ── upsertObjectBatch ────────────────────────────────────────

describe("upsertObjectBatch", () => {
  test("happy path — 3 objects, all ok", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.objects.upsertBatch("room", [
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
      projectId: sixb.execution.projectId,
      objectTypeId: "room",
      primaryId: "r1",
    })
    expect(r1?.properties.name).toBe("Kitchen")
  })

  test("partial failure — mix valid/invalid", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.objects.upsertBatch("room", [
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
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.objects.upsertBatch("room", [
      { properties: { id: "r1" } }, // missing required "name"
      { properties: { id: "r2" } }, // missing required "name"
    ])

    expect(results).toHaveLength(2)
    expect(results.every((r) => !r.ok)).toBe(true)

    // No events should have been created
    const events = await sixb.events.read({ types: ["object.created"] })
    expect(events).toHaveLength(0)
  })

  test("empty batch returns empty array", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.objects.upsertBatch("room", [])
    expect(results).toEqual([])
  })

  test("merge with existing object", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    // Pre-create
    await sixb.objects.upsert("room", { id: "r1", name: "Old Name" })

    const results = await sixb.objects.upsertBatch("room", [
      { properties: { id: "r1", name: "New Name" } },
    ])

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)

    const obj = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.execution.projectId,
      objectTypeId: "room",
      primaryId: "r1",
    })
    expect(obj?.properties.name).toBe("New Name")
  })

  test("publishes one batch of facts for the whole commit", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })
    const publishSpy = spyPublishedFacts(deps.broker)

    await sixb.objects.upsertBatch("room", [
      { properties: { id: "r1", name: "A" } },
      { properties: { id: "r2", name: "B" } },
      { properties: { id: "r3", name: "C" } },
    ])

    await waitFor(
      () => publishSpy.mock.calls.length,
      (callCount) => callCount === 1
    )
    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect(publishSpy.mock.calls[0]?.[0].records.map((event) => event.name)).toEqual([
      "object.created",
      "object.created",
      "object.created",
    ])
  })
})

// ── upsertLinkBatch ──────────────────────────────────────────

describe("upsertLinkBatch", () => {
  test("happy path — 3 links, all ok", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    // Pre-create objects
    await sixb.objects.upsert("room", { id: "r1", name: "Room 1" })
    await sixb.objects.upsert("room", { id: "r2", name: "Room 2" })
    await sixb.objects.upsert("sensor", { id: "s1", name: "Temp" })
    await sixb.objects.upsert("sensor", { id: "s2", name: "Humidity" })

    const results = await sixb.objects.upsertLinkBatch([
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
      projectId: sixb.execution.projectId,
      objectTypeId: "room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links).toHaveLength(2)
  })

  test("ObjectNotFoundError per-item for missing source/target", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    // Only create the sensor, not the room
    await sixb.objects.upsert("sensor", { id: "s1", name: "Temp" })
    await sixb.objects.upsert("room", { id: "r1", name: "Room 1" })

    const results = await sixb.objects.upsertLinkBatch([
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

  test("does not alias endpoint identities containing separators", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [SeparatorSource, SeparatorTarget], ...deps })
    await sixb.objects.upsert("separator:source", { id: "id" })

    const [result] = await sixb.objects.upsertLinkBatch([
      {
        objectTypeId: "separator:source",
        sourceId: "id",
        linkId: "target",
        target: { targetTypeId: "separator", targetId: "source:id" },
      },
    ])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ObjectNotFoundError)
      expect(result.error.message).toContain("Target object not found")
    }
  })

  test("cardinality violation per-item", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    await sixb.objects.upsert("building", { id: "b1", name: "HQ" })
    await sixb.objects.upsert("building", { id: "b2", name: "Branch" })
    await sixb.objects.upsert("room", { id: "r1", name: "Room 1" })

    // Create existing cardinality:one link
    await sixb.objects.upsertLink("room", "r1", "inBuilding", {
      targetTypeId: "building",
      targetId: "b1",
    })

    const results = await sixb.objects.upsertLinkBatch([
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
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.objects.upsertLinkBatch([])
    expect(results).toEqual([])
  })

  test("publishes one batch of facts for the whole commit", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })
    const publishSpy = spyPublishedFacts(deps.broker)

    await sixb.objects.upsert("room", { id: "r1", name: "Room 1" })
    await sixb.objects.upsert("sensor", { id: "s1", name: "Temp" })
    await sixb.objects.upsert("sensor", { id: "s2", name: "Humidity" })

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 3
    )
    publishSpy.mockClear()

    await sixb.objects.upsertLinkBatch([
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

    await waitFor(
      () => publishSpy.mock.calls.length,
      (callCount) => callCount === 1
    )
    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect(publishSpy.mock.calls[0]?.[0].records.map((event) => event.name)).toEqual([
      "link.created",
      "link.created",
    ])
  })
})
