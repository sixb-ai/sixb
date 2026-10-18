import { describe, expect, test } from "bun:test"
import { defineObjectType, link, ObjectNotFoundError, OntologyValidationError, prop } from "../src"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { createTestSixb } from "../src/testing"
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
    link.ref("hasSensors", "sensor", { cardinality: "many" }),
  ],
})

const Sensor = defineObjectType({
  id: "sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

function createRuntime() {
  const deps = createTestRuntimeDeps()
  const sixb = createTestSixb({ ontology: [Building, Room, Sensor], ...deps })
  /** Durable outbox facts: every event a commit will publish, readable without waiting. */
  const facts = () => [
    ...getInMemoryOntologyStorageTestingAdapter(deps.storage.ontology).snapshot().outbox.values(),
  ]
  return { deps, sixb, facts }
}

describe("upsertObjectBatch", () => {
  test("applies valid items in order, merges existing objects, and fails invalid items alone", async () => {
    const { deps, sixb } = createRuntime()
    await sixb.objects.upsert("room", { id: "r1", name: "Old Name" })

    const results = await sixb.objects.upsertBatch("room", [
      { properties: { id: "r1", name: "New Name" } },
      { properties: { id: "r2", name: 12345 } }, // invalid type for "name"
      { properties: { id: "r3", name: "Bathroom" } },
    ])

    expect(results.map((result) => result.ok)).toEqual([true, false, true])
    if (results[0].ok) expect(results[0].value.primaryId).toBe("r1")
    if (results[2].ok) expect(results[2].value.primaryId).toBe("r3")
    if (!results[1].ok) expect(results[1].error).toBeInstanceOf(OntologyValidationError)

    const stored = await deps.storage.objects.getByPrimaryIdBatch({
      projectId: sixb.execution.projectId,
      items: ["r1", "r2", "r3"].map((primaryId) => ({ objectTypeId: "room", primaryId })),
    })
    expect([...stored.values()].map((row) => [row.primaryId, row.properties.name])).toEqual([
      ["r1", "New Name"],
      ["r3", "Bathroom"],
    ])
  })

  test("emits no events when every item fails", async () => {
    const { sixb, facts } = createRuntime()

    const results = await sixb.objects.upsertBatch("room", [
      { properties: { id: "r1" } }, // missing required "name"
      { properties: { id: "r2" } }, // missing required "name"
    ])

    expect(results.map((result) => result.ok)).toEqual([false, false])
    expect(facts()).toEqual([])
  })

  test("commits the whole batch once", async () => {
    const { sixb, facts } = createRuntime()

    await sixb.objects.upsertBatch("room", [
      { properties: { id: "r1", name: "A" } },
      { properties: { id: "r2", name: "B" } },
      { properties: { id: "r3", name: "C" } },
    ])

    const batchFacts = facts()
    expect(batchFacts.map((row) => row.event.type)).toEqual([
      "object.created",
      "object.created",
      "object.created",
    ])
    expect(new Set(batchFacts.map((row) => row.commitId)).size).toBe(1)
  })

  test("returns an empty result for an empty batch, of objects or links", async () => {
    const { sixb } = createRuntime()

    expect(await sixb.objects.upsertBatch("room", [])).toEqual([])
    expect(await sixb.objects.upsertLinkBatch([])).toEqual([])
  })
})

describe("upsertLinkBatch", () => {
  test("creates every link of the batch in one commit", async () => {
    const { deps, sixb, facts } = createRuntime()
    await sixb.objects.upsert("room", { id: "r1", name: "Room 1" })
    await sixb.objects.upsert("room", { id: "r2", name: "Room 2" })
    await sixb.objects.upsert("sensor", { id: "s1", name: "Temp" })
    await sixb.objects.upsert("sensor", { id: "s2", name: "Humidity" })
    const before = facts().length

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

    expect(results.map((result) => result.ok)).toEqual([true, true, true])
    const links = await deps.storage.objects.listLinks({
      projectId: sixb.execution.projectId,
      objectTypeId: "room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links.map((row) => row.targetId).sort()).toEqual(["s1", "s2"])

    const batchFacts = facts().slice(before)
    expect(batchFacts.map((row) => row.event.type)).toEqual([
      "link.created",
      "link.created",
      "link.created",
    ])
    expect(new Set(batchFacts.map((row) => row.commitId)).size).toBe(1)
  })

  test("ObjectNotFoundError per-item for missing source/target", async () => {
    const { sixb } = createRuntime()

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

  test("cardinality violation per-item", async () => {
    const { sixb } = createRuntime()

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
})
