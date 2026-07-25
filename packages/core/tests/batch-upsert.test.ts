import { describe, expect, mock, test } from "bun:test"
import {
  defineObjectType,
  link,
  ObjectNotFoundError,
  OntologyValidationError,
  prop,
  Sixb,
} from "../src"
import type { EventsRuntime } from "../src/events"
import { objectService } from "../src/objects"
import { createTestRuntimeDeps } from "./test-runtime-deps"

/** Mutations publish durable outbox facts, so delivery is observed on the publication boundary. */
function spyPublishedFacts(events: EventsRuntime) {
  const publish = events.publishEnvelopes.bind(events)
  const spy = mock(publish)
  events.publishEnvelopes = spy
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
    /** Cardinality-one with a required link property, which `setLinkBatch` cannot supply. */
    link("primaryBuilding", Building, {
      cardinality: "one",
      properties: [prop("since", "string", { required: true })],
    }),
    link.ref("hasSensors", "sensor", { cardinality: "many" }),
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
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.upsertObjectBatch("room", [
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
      projectId: sixb.id,
      objectTypeId: "room",
      primaryId: "r1",
    })
    expect(r1?.properties.name).toBe("Kitchen")
  })

  test("partial failure — mix valid/invalid", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.upsertObjectBatch("room", [
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
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.upsertObjectBatch("room", [
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
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.upsertObjectBatch("room", [])
    expect(results).toEqual([])
  })

  test("merge with existing object", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    // Pre-create
    await sixb.upsertObject("room", { id: "r1", name: "Old Name" })

    const results = await sixb.upsertObjectBatch("room", [
      { properties: { id: "r1", name: "New Name" } },
    ])

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)

    const obj = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "room",
      primaryId: "r1",
    })
    expect(obj?.properties.name).toBe("New Name")
  })

  test("publishes one batch of facts for the whole commit", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })
    const publishSpy = spyPublishedFacts(sixb.events)

    await sixb.upsertObjectBatch("room", [
      { properties: { id: "r1", name: "A" } },
      { properties: { id: "r2", name: "B" } },
      { properties: { id: "r3", name: "C" } },
    ])

    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect(publishSpy.mock.calls[0]?.[0].map((event) => event.type)).toEqual([
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
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    // Pre-create objects
    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })
    await sixb.upsertObject("room", { id: "r2", name: "Room 2" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })
    await sixb.upsertObject("sensor", { id: "s2", name: "Humidity" })

    const results = await sixb.upsertLinkBatch([
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
      projectId: sixb.id,
      objectTypeId: "room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links).toHaveLength(2)
  })

  test("ObjectNotFoundError per-item for missing source/target", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    // Only create the sensor, not the room
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })
    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })

    const results = await sixb.upsertLinkBatch([
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
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    await sixb.upsertObject("building", { id: "b1", name: "HQ" })
    await sixb.upsertObject("building", { id: "b2", name: "Branch" })
    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })

    // Create existing cardinality:one link
    await sixb.upsertLink("room", "r1", "inBuilding", {
      targetTypeId: "building",
      targetId: "b1",
    })

    const results = await sixb.upsertLinkBatch([
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
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    const results = await sixb.upsertLinkBatch([])
    expect(results).toEqual([])
  })

  test("publishes one batch of facts for the whole commit", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })
    const publishSpy = spyPublishedFacts(sixb.events)

    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })
    await sixb.upsertObject("sensor", { id: "s2", name: "Humidity" })

    publishSpy.mockClear()

    await sixb.upsertLinkBatch([
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

    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect(publishSpy.mock.calls[0]?.[0].map((event) => event.type)).toEqual([
      "link.created",
      "link.created",
    ])
  })
})

// ── setLinkBatch ─────────────────────────────────────────────

describe("setLinkBatch", () => {
  test("atomically replaces a cardinality-one target", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    await sixb.upsertObject("building", { id: "b1", name: "HQ" })
    await sixb.upsertObject("building", { id: "b2", name: "Branch" })
    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })
    await sixb.upsertLink("room", "r1", "inBuilding", {
      targetTypeId: "building",
      targetId: "b1",
    })
    const publishSpy = spyPublishedFacts(sixb.events)

    const results = await objectService.setLinkBatch(sixb, [
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "inBuilding",
        target: { targetTypeId: "building", targetId: "b2" },
      },
    ])

    expect(results).toEqual([{ ok: true, value: undefined }])
    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "room",
      objectId: "r1",
      linkId: "inBuilding",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("b2")
    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect([...(publishSpy.mock.calls[0]?.[0] ?? [])].map((event) => event.type).sort()).toEqual([
      "link.created",
      "link.deleted",
    ])
  })

  test("preserves the current target when the desired target is missing", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    await sixb.upsertObject("building", { id: "b1", name: "HQ" })
    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })
    await sixb.upsertLink("room", "r1", "inBuilding", {
      targetTypeId: "building",
      targetId: "b1",
    })

    const results = await objectService.setLinkBatch(sixb, [
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "inBuilding",
        target: { targetTypeId: "building", targetId: "missing-building" },
      },
    ])

    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(false)
    if (!results[0]?.ok) {
      expect(results[0].error).toBeInstanceOf(ObjectNotFoundError)
    }
    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "room",
      objectId: "r1",
      linkId: "inBuilding",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("b1")
  })

  test("keeps the current target when the assignment fails inside the commit", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    for (const id of ["b1", "b2"]) {
      await sixb.upsertObject("building", { id, name: id })
    }
    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })
    await sixb.upsertLink("room", "r1", "primaryBuilding", {
      targetTypeId: "building",
      targetId: "b1",
      properties: { since: "2020" },
    })

    // The endpoints exist, so planning succeeds and the item reaches the commit as an ordered
    // `link.delete` + `link.upsert`. The upsert then fails the required-property check, which the
    // delete must not outlive.
    const results = await objectService.setLinkBatch(sixb, [
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "primaryBuilding",
        target: { targetTypeId: "building", targetId: "b2" },
      },
    ])

    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(false)

    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "room",
      objectId: "r1",
      linkId: "primaryBuilding",
    })
    expect(links.map((assigned) => assigned.targetId)).toEqual(["b1"])
  })

  test("rolls back a failed assignment without disturbing the rest of the batch", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    for (const id of ["b1", "b2"]) {
      await sixb.upsertObject("building", { id, name: id })
    }
    for (const roomId of ["r1", "r2"]) {
      await sixb.upsertObject("room", { id: roomId, name: roomId })
    }
    await sixb.upsertLink("room", "r1", "primaryBuilding", {
      targetTypeId: "building",
      targetId: "b1",
      properties: { since: "2020" },
    })
    await sixb.upsertLink("room", "r2", "inBuilding", {
      targetTypeId: "building",
      targetId: "b1",
    })

    const results = await objectService.setLinkBatch(sixb, [
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "primaryBuilding",
        target: { targetTypeId: "building", targetId: "b2" },
      },
      {
        objectTypeId: "room",
        sourceId: "r2",
        linkId: "inBuilding",
        target: { targetTypeId: "building", targetId: "b2" },
      },
    ])

    expect(results[0]?.ok).toBe(false)
    expect(results[1]).toEqual({ ok: true, value: undefined })

    const [r1Links, r2Links] = await Promise.all(
      [
        { objectId: "r1", linkId: "primaryBuilding" },
        { objectId: "r2", linkId: "inBuilding" },
      ].map((scope) =>
        deps.storage.objects.listLinks({
          projectId: sixb.id,
          objectTypeId: "room",
          ...scope,
        })
      )
    )
    expect(r1Links?.map((assigned) => assigned.targetId)).toEqual(["b1"])
    expect(r2Links?.map((assigned) => assigned.targetId)).toEqual(["b2"])
  })

  test("serializes concurrent assignments without cardinality violations", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    for (const buildingId of ["b1", "b2"]) {
      await sixb.upsertObject("building", { id: buildingId, name: buildingId })
    }
    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })

    const results = await Promise.all(
      ["b1", "b2"].map((targetId) =>
        objectService.setLinkBatch(sixb, [
          {
            objectTypeId: "room",
            sourceId: "r1",
            linkId: "inBuilding",
            target: { targetTypeId: "building", targetId },
          },
        ])
      )
    )

    // Assignment reads the current target before committing, so a lost race reports an item error
    // instead of violating cardinality.
    expect(results.flat().filter((result) => result.ok).length).toBeGreaterThanOrEqual(1)
    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "room",
      objectId: "r1",
      linkId: "inBuilding",
    })
    expect(links).toHaveLength(1)
    expect(["b1", "b2"]).toContain(links[0]?.targetId)
  })

  test("rejects assignment semantics for cardinality-many links", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({ ontology: [Building, Room, Sensor], ...deps })

    await sixb.upsertObject("room", { id: "r1", name: "Room 1" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })

    await expect(
      objectService.setLinkBatch(sixb, [
        {
          objectTypeId: "room",
          sourceId: "r1",
          linkId: "hasSensors",
          target: { targetTypeId: "sensor", targetId: "s1" },
        },
      ])
    ).rejects.toThrow("setLinkBatch requires cardinality 'one' link 'room.hasSensors'")
  })
})
