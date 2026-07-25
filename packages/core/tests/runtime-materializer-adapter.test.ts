import { describe, expect, mock, test } from "bun:test"
import {
  defineObjectType,
  type InMemoryStorage,
  link,
  MaterializationValidationError,
  ObjectNotFoundError,
  OntologyValidationError,
  prop,
  Sixb,
} from "../src"
import { type EventsRuntime, OntologyOutboxDispatcher } from "../src/events"
import { objectService } from "../src/objects"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Sensor = defineObjectType({
  id: "sensor",
  name: "Sensor",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

const Room = defineObjectType({
  id: "room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("note", "string", { nullable: true }),
  ],
  links: [
    link("primarySensor", Sensor, { cardinality: "one" }),
    link("sensors", Sensor, {
      cardinality: "many",
      properties: [prop("role", "string")],
    }),
  ],
})

const ONTOLOGY = [Room, Sensor] as const

function createRuntime() {
  const deps = createTestRuntimeDeps()
  const sixb = new Sixb({ id: "runtime-adapter-tests", ontology: ONTOLOGY, ...deps })
  return { deps, sixb }
}

type AdapterRuntime = ReturnType<typeof createRuntime>["sixb"]

async function commitOrigins(sixb: AdapterRuntime) {
  const { commits } = await sixb.storage.ontology.commits.list({ projectId: sixb.id })
  return commits.map((commit) => commit.origin.kind)
}

async function listSensorLinks(sixb: AdapterRuntime, linkId: string) {
  return sixb.storage.objects.listLinks({
    projectId: sixb.id,
    objectTypeId: "room",
    objectId: "r1",
    linkId,
  })
}

describe("runtime object writes", () => {
  test("typed and dynamic mutations all commit through the materializer as runtime origins", async () => {
    const { sixb } = createRuntime()

    await sixb.objects(Sensor).upsert({ properties: { id: "s1", name: "Temp" } })
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await sixb.objects(Room).byId("r1").link(Room.l.primarySensor, {
      objectTypeId: "sensor",
      primaryId: "s1",
    })
    await sixb.objects(Room).byId("r1").unlink(Room.l.primarySensor, {
      objectTypeId: "sensor",
      primaryId: "s1",
    })
    await sixb.upsertLink("room", "r1", "sensors", {
      targetTypeId: "sensor",
      targetId: "s1",
      properties: { role: "primary" },
    })
    await sixb.removeLink("room", "r1", "sensors", { targetTypeId: "sensor", targetId: "s1" })

    expect(await commitOrigins(sixb)).toEqual(new Array(6).fill("runtime"))
  })

  test("upserts an absent identity as a create and an existing one as a patch", async () => {
    const { sixb } = createRuntime()

    const created = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    expect(created.version).toBe(1)
    expect(created.properties).toEqual({ id: "r1", name: "Kitchen" })

    const patched = await sixb.upsertObject("room", { id: "r1", note: "Warm" })
    expect(patched.version).toBe(2)
    expect(patched.properties).toEqual({ id: "r1", name: "Kitchen", note: "Warm" })
    expect(patched.createdAt).toEqual(created.createdAt)
  })

  test("restores a tombstoned identity through a later upsert", async () => {
    const { sixb } = createRuntime()
    const created = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })

    await sixb.materializer.edits.commit({
      mode: "atomic",
      source: { kind: "runtime", requestId: "delete-room" },
      operations: [
        { id: "op:0", kind: "object.delete", ref: { objectTypeId: "room", primaryId: "r1" } },
      ],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })
    expect(
      await sixb.storage.objects.getByPrimaryId({
        projectId: sixb.id,
        objectTypeId: "room",
        primaryId: "r1",
      })
    ).toBeNull()

    // Restoring replaces the tombstone with independent create authority, so the effective object is
    // materialized fresh rather than resuming the deleted row's revision.
    const restored = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    expect(restored.properties).toEqual({ id: "r1", name: "Kitchen" })
    expect(restored.version).toBe(1)
    expect(restored.lastCommitId).not.toBe(created.lastCommitId)
  })

  test("keeps a same-value upsert an effective no-op", async () => {
    const { sixb } = createRuntime()
    const created = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    const publishSpy = spyPublishedFacts(sixb.events)

    const replayed = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })

    expect(replayed).toEqual(created)
    expect(publishSpy).not.toHaveBeenCalled()
    // The commit is still recorded: the request was durable even though nothing changed.
    expect(await commitOrigins(sixb)).toEqual(["runtime", "runtime"])
  })

  test("treats removing a missing link as a no-op", async () => {
    const { sixb } = createRuntime()
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })
    const publishSpy = spyPublishedFacts(sixb.events)

    await sixb.removeLink("room", "r1", "sensors", { targetTypeId: "sensor", targetId: "s1" })

    expect(publishSpy).not.toHaveBeenCalled()
    expect(await listSensorLinks(sixb, "sensors")).toEqual([])
  })

  test("reports a missing link endpoint as an object-not-found failure", async () => {
    const { sixb } = createRuntime()
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })

    await expect(
      sixb.upsertLink("room", "r1", "sensors", { targetTypeId: "sensor", targetId: "missing" })
    ).rejects.toBeInstanceOf(ObjectNotFoundError)
  })

  test("surfaces effective validation from the materializer", async () => {
    const { sixb } = createRuntime()

    await expect(sixb.upsertObject("room", { id: "r1" })).rejects.toBeInstanceOf(
      MaterializationValidationError
    )
  })
})

describe("runtime object batches", () => {
  test("keeps local errors, item errors, and successes at their input positions", async () => {
    const { sixb } = createRuntime()
    await sixb.upsertObject("room", { id: "r2", name: "Bedroom" })

    const results = await sixb.upsertObjectBatch("room", [
      { properties: { id: "r1", name: "Kitchen" } },
      { properties: { name: "No identity" } },
      { properties: { id: "r3" } },
      { properties: { id: "r2", note: "Cool" } },
    ])

    expect(results.map((result) => result.ok)).toEqual([true, false, false, true])
    expect(results[0].ok && results[0].value.primaryId).toBe("r1")
    expect(results[1].ok === false && results[1].error).toBeInstanceOf(OntologyValidationError)
    expect(results[2].ok === false && results[2].error.message).toContain(
      "Missing required property 'name'"
    )
    expect(results[3].ok && results[3].value.properties).toEqual({
      id: "r2",
      name: "Bedroom",
      note: "Cool",
    })
  })

  test("collapses an identical repeat and rejects a conflicting one", async () => {
    const { sixb } = createRuntime()

    const results = await sixb.upsertObjectBatch("room", [
      { properties: { id: "r1", name: "Kitchen" } },
      { properties: { id: "r1", name: "Kitchen" } },
      { properties: { id: "r1", name: "Renamed" } },
    ])

    expect(results.map((result) => result.ok)).toEqual([true, true, false])
    expect(results[0]).toEqual(results[1])
    expect(results[2].ok === false && results[2].error.message).toContain(
      "Conflicting duplicate object 'room:r1'"
    )
    expect(
      (
        await sixb.storage.objects.getByPrimaryId({
          projectId: sixb.id,
          objectTypeId: "room",
          primaryId: "r1",
        })
      )?.properties.name
    ).toBe("Kitchen")
  })

  test("propagates a commit failure instead of turning it into item errors", async () => {
    const { deps, sixb } = createRuntime()
    sixb.materializer.edits.commit = () => Promise.reject(new Error("provider exploded"))

    await expect(
      sixb.upsertObjectBatch("room", [
        { properties: { id: "r1", name: "Kitchen" } },
        { properties: { id: "r2", name: "Bedroom" } },
      ])
    ).rejects.toThrow("provider exploded")

    const rows = await deps.storage.objects.list({ projectId: sixb.id, objectTypeId: "room" })
    expect(rows.objects).toEqual([])
  })
})

describe("runtime link batches", () => {
  test("applies ordered items against one evolving cardinality", async () => {
    const { sixb } = createRuntime()
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    for (const sensorId of ["s1", "s2"]) {
      await sixb.upsertObject("sensor", { id: sensorId, name: sensorId })
    }

    const results = await sixb.upsertLinkBatch([
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "primarySensor",
        target: { targetTypeId: "sensor", targetId: "s1" },
      },
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "primarySensor",
        target: { targetTypeId: "sensor", targetId: "s2" },
      },
    ])

    expect(results.map((result) => result.ok)).toEqual([true, false])
    expect(results[1].ok === false && results[1].error.message).toContain("cardinality one")
    expect((await listSensorLinks(sixb, "primarySensor")).map((row) => row.targetId)).toEqual([
      "s1",
    ])
  })

  test("collapses identical duplicates and rejects conflicting ones", async () => {
    const { sixb } = createRuntime()
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })

    const item = {
      objectTypeId: "room",
      sourceId: "r1",
      linkId: "sensors",
      target: { targetTypeId: "sensor", targetId: "s1", properties: { role: "primary" } },
    }
    const results = await sixb.upsertLinkBatch([
      item,
      item,
      { ...item, target: { ...item.target, properties: { role: "backup" } } },
    ])

    expect(results.map((result) => result.ok)).toEqual([true, true, false])
    expect(results[2].ok === false && results[2].error.message).toContain(
      "Conflicting duplicate link"
    )
    expect((await listSensorLinks(sixb, "sensors")).map((row) => row.properties?.role)).toEqual([
      "primary",
    ])
  })

  test("reassigns a cardinality-one link and reports missing endpoints per item", async () => {
    const { sixb } = createRuntime()
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    for (const sensorId of ["s1", "s2"]) {
      await sixb.upsertObject("sensor", { id: sensorId, name: sensorId })
    }
    await sixb.upsertLink("room", "r1", "primarySensor", {
      targetTypeId: "sensor",
      targetId: "s1",
    })

    const results = await objectService.setLinkBatch(sixb, [
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "primarySensor",
        target: { targetTypeId: "sensor", targetId: "s2" },
      },
      {
        objectTypeId: "room",
        sourceId: "r1",
        linkId: "primarySensor",
        target: { targetTypeId: "sensor", targetId: "missing" },
      },
    ])

    expect(results[0]).toEqual({ ok: true, value: undefined })
    expect(results[1].ok === false && results[1].error).toBeInstanceOf(ObjectNotFoundError)
    expect((await listSensorLinks(sixb, "primarySensor")).map((row) => row.targetId)).toEqual([
      "s2",
    ])
  })
})

describe("committed fact delivery", () => {
  test("keeps committed facts durable through a broker outage and delivers them later", async () => {
    const { deps, sixb } = createRuntime()
    let outage = true
    const publish = sixb.events.publishEnvelopes.bind(sixb.events)
    sixb.events.publishEnvelopes = async (envelopes) => {
      if (outage) throw new Error("broker unavailable")
      return publish(envelopes)
    }

    const created = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    expect(created.properties.name).toBe("Kitchen")
    expect(await sixb.events.read({ types: ["object.created"] })).toHaveLength(0)

    outage = false
    // A failed publication backs the row off before retrying, so recovery runs past that window.
    await new OntologyOutboxDispatcher({
      projectId: sixb.id,
      storage: deps.storage,
      events: sixb.events,
      now: () => new Date(Date.now() + 60_000),
    }).drain()

    const delivered = await sixb.events.read({ types: ["object.created"] })
    expect(
      delivered.map((event) => ("primaryId" in event.payload ? event.payload.primaryId : undefined))
    ).toEqual(["r1"])
  })

  test("never appends events or writes providers outside the materializer", async () => {
    const { deps, sixb } = createRuntime()
    const appendSpy = mock(sixb.events.append.bind(sixb.events))
    sixb.events.append = appendSpy
    const providerWrites = spyLegacyProviderWrites(deps.storage)

    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })
    await sixb.upsertLink("room", "r1", "sensors", {
      targetTypeId: "sensor",
      targetId: "s1",
    })
    await sixb.removeLink("room", "r1", "sensors", { targetTypeId: "sensor", targetId: "s1" })
    await sixb.upsertObjectBatch("room", [{ properties: { id: "r2", name: "Bedroom" } }])

    expect(appendSpy).not.toHaveBeenCalled()
    expect(providerWrites.filter((spy) => spy.mock.calls.length > 0)).toEqual([])
  })
})

/** Mutations write durable outbox facts, so publication is the observable delivery boundary. */
function spyPublishedFacts(events: EventsRuntime) {
  const publish = events.publishEnvelopes.bind(events)
  const spy = mock(publish)
  events.publishEnvelopes = spy
  return spy
}

/** Watches the event-command provider methods the Materializer replaced. */
function spyLegacyProviderWrites(storage: InMemoryStorage) {
  const names = [
    "applyObjectUpsert",
    "applyObjectUpsertBatch",
    "applyLinkUpsert",
    "applyLinkUpsertBatch",
    "applyLinkDelete",
  ] as const
  return names.map((name) => {
    const spy = mock(storage.objects[name].bind(storage.objects))
    Object.defineProperty(storage.objects, name, { value: spy, configurable: true })
    return spy
  })
}
