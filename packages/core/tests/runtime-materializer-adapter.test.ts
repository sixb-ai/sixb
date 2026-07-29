import { describe, expect, mock, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBroker,
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
import { getOntologyMutationRuntime } from "../src/runtime/internal"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
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
      properties: [prop("role", "string"), prop("note", "string")],
    }),
    link("certifiedSensors", Sensor, {
      cardinality: "many",
      properties: [prop("role", "string", { required: true })],
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

    // The runtime verb, not a hand-built commit: proving that the gap `delete()` closes was real.
    await sixb.objects(Room).byId("r1").delete()
    expect(await sixb.objects(Room).byId("r1").get()).toBeNull()

    // Restoring replaces the tombstone with independent create authority, so the effective object is
    // materialized fresh rather than resuming the deleted row's revision.
    const restored = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    expect(restored.properties).toEqual({ id: "r1", name: "Kitchen" })
    expect(restored.version).toBe(1)
    expect(restored.lastCommitId).not.toBe(created.lastCommitId)
  })

  test("delete cascades over links and restore is a no-op for code-owned objects", async () => {
    const { sixb } = createRuntime()
    await sixb.upsertObject("sensor", { id: "s1", name: "Thermostat" })
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await sixb.objects(Room).byId("r1").link(Room.l.primarySensor, {
      objectTypeId: "sensor",
      primaryId: "s1",
    })
    expect(await sixb.objects(Room).byId("r1").listLinks()).toHaveLength(1)

    await sixb.objects(Room).byId("r1").delete()
    expect(await sixb.objects(Room).byId("r1").get()).toBeNull()
    // The cascade is part of the same commit, so no dangling edge survives the delete.
    expect(await sixb.objects(Room).byId("r1").listLinks()).toEqual([])
    // The link target itself is untouched.
    expect(await sixb.objects(Sensor).byId("s1").get()).not.toBeNull()

    // Nothing else asserts this object, so there is nothing left to reveal.
    await sixb.objects(Room).byId("r1").restore()
    expect(await sixb.objects(Room).byId("r1").get()).toBeNull()

    // Deleting an identity that does not exist is a no-op rather than an error.
    await sixb.objects(Room).byId("never-existed").delete()
  })

  test("keeps a same-value upsert an effective no-op", async () => {
    const { sixb } = createRuntime()
    const created = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await waitForDeliveredEvents(sixb, 1)
    const publishSpy = spyPublishedFacts(sixb.events as EventsRuntime)

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
    await waitForDeliveredEvents(sixb, 2)
    const publishSpy = spyPublishedFacts(sixb.events as EventsRuntime)

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

  test("replaces the whole link property set on upsert", async () => {
    // Managed link authority carries the complete property set, so a link upsert is a replace, not
    // a merge: properties left out are cleared. Documented in docs/ontology/links.md.
    const { sixb } = createRuntime()
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })

    await sixb.upsertLink("room", "r1", "sensors", {
      targetTypeId: "sensor",
      targetId: "s1",
      properties: { role: "primary", note: "installed 2026" },
    })
    expect((await listSensorLinks(sixb, "sensors"))[0]?.properties).toEqual({
      role: "primary",
      note: "installed 2026",
    })

    await sixb.upsertLink("room", "r1", "sensors", {
      targetTypeId: "sensor",
      targetId: "s1",
      properties: { note: "recalibrated" },
    })
    expect((await listSensorLinks(sixb, "sensors"))[0]?.properties).toEqual({
      note: "recalibrated",
    })
  })

  test("requires link properties in the request rather than inheriting the stored edge", async () => {
    // The same replace rule means a required link property must be present on every write; it is
    // not carried over from the edge already stored.
    const { sixb } = createRuntime()
    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })
    await sixb.upsertLink("room", "r1", "certifiedSensors", {
      targetTypeId: "sensor",
      targetId: "s1",
      properties: { role: "primary" },
    })

    await expect(
      sixb.upsertLink("room", "r1", "certifiedSensors", {
        targetTypeId: "sensor",
        targetId: "s1",
        properties: {},
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    expect((await listSensorLinks(sixb, "certifiedSensors"))[0]?.properties).toEqual({
      role: "primary",
    })
  })

  test("surfaces effective validation from the materializer", async () => {
    const { sixb } = createRuntime()

    await expect(sixb.upsertObject("room", { id: "r1" })).rejects.toBeInstanceOf(
      MaterializationValidationError
    )
  })

  test("single and batch writes report the same validation failure catchably", async () => {
    // The batch path rewraps materializer item errors as OntologyValidationError. A caller that
    // branches on `instanceof OntologyValidationError` must catch the single-write error too, or
    // the same invalid input is skippable through one API and fatal through the other.
    const { sixb } = createRuntime()

    const single = await sixb.upsertObject("room", { id: "r1" }).catch((error: unknown) => error)
    const [batch] = await sixb.upsertObjectBatch("room", [{ properties: { id: "r1" } }])

    expect(single).toBeInstanceOf(OntologyValidationError)
    expect(batch?.ok === false && batch.error).toBeInstanceOf(OntologyValidationError)
    expect((single as Error).message).toBe(
      batch?.ok === false ? batch.error.message : "<no batch error>"
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
    getOntologyMutationRuntime(sixb).commitEdits = () =>
      Promise.reject(new Error("provider exploded"))

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
  test("returns after the durable commit even when broker publication never settles", async () => {
    const deps = createTestRuntimeDeps()
    const broker = new NeverSettlingBroker()
    const sixb = new Sixb({
      id: "nonblocking-publication",
      ontology: ONTOLOGY,
      ...deps,
      broker,
    })

    const created = await Promise.race([
      sixb.upsertObject("room", { id: "r1", name: "Kitchen" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("mutation waited for broker publication")), 100)
      ),
    ])

    expect(created.properties.name).toBe("Kitchen")
    await broker.started
    expect(
      await sixb.storage.objects.getByPrimaryId({
        projectId: sixb.id,
        objectTypeId: "room",
        primaryId: "r1",
      })
    ).not.toBeNull()
  })

  test("keeps committed facts durable through a broker outage and delivers them later", async () => {
    const { deps, sixb } = createRuntime()
    let outage = true
    const eventRuntime = sixb.events as EventsRuntime
    const publish = eventRuntime.publishEnvelopes.bind(eventRuntime)
    eventRuntime.publishEnvelopes = async (envelopes) => {
      if (outage) throw new Error("broker unavailable")
      return publish(envelopes)
    }

    const created = await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    expect(created.properties.name).toBe("Kitchen")
    expect(await sixb.events.read({ types: ["object.created"] })).toHaveLength(0)
    await waitForOutboxRetry(deps.storage)

    outage = false
    // A failed publication backs the row off before retrying, so recovery runs past that window.
    await new OntologyOutboxDispatcher({
      projectId: sixb.id,
      storage: deps.storage,
      events: eventRuntime,
      now: () => new Date(Date.now() + 60_000),
    }).drain()

    const delivered = await sixb.events.read({ types: ["object.created"] })
    expect(
      delivered.map((event) => ("primaryId" in event.payload ? event.payload.primaryId : undefined))
    ).toEqual(["r1"])
  })

  test("never appends events outside the materializer", async () => {
    const { sixb } = createRuntime()
    const appendSpy = mock(sixb.events.append.bind(sixb.events))
    sixb.events.append = appendSpy

    await sixb.upsertObject("room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("sensor", { id: "s1", name: "Temp" })
    await sixb.upsertLink("room", "r1", "sensors", {
      targetTypeId: "sensor",
      targetId: "s1",
    })
    await sixb.removeLink("room", "r1", "sensors", { targetTypeId: "sensor", targetId: "s1" })
    await sixb.upsertObjectBatch("room", [{ properties: { id: "r2", name: "Bedroom" } }])

    expect(appendSpy).not.toHaveBeenCalled()
  })
})

/** Mutations write durable outbox facts, so publication is the observable delivery boundary. */
function spyPublishedFacts(events: EventsRuntime) {
  const publish = events.publishEnvelopes.bind(events)
  const spy = mock(publish)
  events.publishEnvelopes = spy
  return spy
}

class NeverSettlingBroker extends InMemoryBroker {
  private resolveStarted!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve
  })

  override append(): ReturnType<InMemoryBroker["append"]> {
    this.resolveStarted()
    return new Promise(() => undefined)
  }
}

async function waitForDeliveredEvents(sixb: AdapterRuntime, count: number): Promise<void> {
  await waitFor(() => sixb.events.read().then((events) => events.length >= count))
}

async function waitForOutboxRetry(storage: InMemoryStorage): Promise<void> {
  await waitFor(() => {
    const rows = [
      ...getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot().outbox.values(),
    ]
    return rows.length > 0 && rows.every((row) => row.attempts > 0 && row.leaseId === null)
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous delivery.")
    await Bun.sleep(1)
  }
}
