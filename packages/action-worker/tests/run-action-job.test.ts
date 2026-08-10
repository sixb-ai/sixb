import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  type ActionSubject,
  defineAction,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  param,
  prop,
  Sixb,
} from "@sixb/core"
import { findActionEditCommit } from "@sixb/core/internal/actions"
import { attachSixbErrorReporter } from "@sixb/core/internal/error-reporting"
import type { EventsRuntime } from "@sixb/core/internal/events"
import { getOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type { ActionRunParams } from "@sixb/core/storage"
import { ActionWorkerError } from "../src/errors"
import { runActionJob } from "../src/run-action-job"
import type { ActionWorkerContext } from "../src/types"
import type { ActionWorkerSixb } from "../src/worker"

const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("status", "string"),
  ],
  links: [link.ref("sensor", "Sensor", { cardinality: "one" })],
})

const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

interface DeviceObjectSet {
  upsert(input: { properties: Record<string, unknown> }): Promise<unknown>
  get(id: string): Promise<{ properties: Record<string, unknown> } | null>
}

interface TestSixb extends ActionWorkerSixb {
  readonly events: EventsRuntime
  readonly storage: InMemoryStorage
  readonly objects: ActionWorkerContext["sixb"]["objects"]
}

const SixbConstructor = Sixb as unknown as new (options: Record<string, unknown>) => TestSixb

function deviceObjects(sixb: TestSixb): DeviceObjectSet {
  return sixb.objects(Device)
}

function createSixb(
  actions: readonly ActionDefinition[],
  ontology: readonly unknown[] = [Device]
): TestSixb {
  return new SixbConstructor({
    id: "action-worker-tests",
    ontology,
    actions,
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

function createContext(sixb: TestSixb): ActionWorkerContext {
  return {
    id: sixb.id,
    errorReporterHost: sixb,
    events: sixb.events,
    storage: sixb.storage,
    actionRunsStorage: sixb.storage.actionRuns!,
    ontologyMutations: getOntologyMutationRuntime(sixb),
    sixb: {
      objects: sixb.objects,
      actions: sixb.actions,
      connectors: sixb.connectors,
      blobs: sixb.blobs,
    },
    actions: sixb.actions,
  }
}

async function queueActionRun(
  sixb: TestSixb,
  input: {
    readonly id: string
    readonly actionId: string
    readonly subject: ActionSubject
    readonly params: ActionRunParams
  }
): Promise<void> {
  await sixb.storage.actionRuns!.queue({
    projectId: sixb.id,
    id: input.id,
    actionId: input.actionId,
    subject: input.subject,
    params: input.params,
    idempotencyKey: `action:${sixb.id}:${input.id}`,
  })
}

describe("runActionJob", () => {
  test("throws ActionWorkerError when the stored run is missing", async () => {
    const count = defineAction("count")
      .params({})
      .writeback(() => {})
    const sixb = createSixb([count])

    await expect(
      runActionJob({
        runtime: createContext(sixb),
        job: {
          id: "act_missing",
          actionId: "count",
        },
      })
    ).rejects.toBeInstanceOf(ActionWorkerError)
  })

  test("passes nullable params to action handlers unchanged", async () => {
    let received: Date | null = new Date(0)
    const captureNullable = defineAction("captureNullable")
      .params({ reviewedAt: param("timestamp", { nullable: true }) })
      .writeback(({ params }) => {
        received = params.reviewedAt
      })
    const sixb = createSixb([captureNullable])
    await queueActionRun(sixb, {
      id: "act_nullable",
      actionId: "captureNullable",
      subject: { kind: "none" },
      params: { reviewedAt: null },
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_nullable", actionId: "captureNullable" },
    })

    expect(result.status).toBe("succeeded")
    expect(received).toBeNull()
  })

  test("commits edits and stores a succeeded run", async () => {
    const setStatus = defineAction("setStatus")
      .on(Device)
      .params({ status: param("string") })
      .edits(({ objects, params, subject, signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        objects(Device).byId(subject.primaryId).update({ status: params.status })
      })

    const sixb = createSixb([setStatus])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: { status: "ready" },
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "setStatus",
      },
    })

    expect(result.status).toBe("succeeded")
    const run = await sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: "act_1" })
    expect(run?.status).toBe("succeeded")
    expect(run?.phase).toBe("commit")
    const commit = await findActionEditCommit({
      storage: sixb.storage,
      projectId: sixb.id,
      runId: "act_1",
    })
    expect(commit?.changes.objects.map((change) => [change.kind, change.ref.primaryId])).toEqual([
      ["updated", "device-1"],
    ])
    expect(Object.keys(commit?.changes.objects[0]?.propertyChanges ?? {})).toEqual(["status"])

    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("ready")
  })

  test("fails writeback before local commit", async () => {
    const failWriteback = defineAction("failWriteback")
      .on(Device)
      .params({})
      .writeback(() => {
        throw new Error("external API failed")
      })
      .edits(({ objects, subject }) => {
        objects(Device).byId(subject.primaryId).update({ status: "should-not-commit" })
      })

    const sixb = createSixb([failWriteback])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
      status: "old",
    })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "failWriteback",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "failWriteback",
      },
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error).toEqual({
        name: "Error",
        message: "external API failed",
        phase: "writeback",
      })
    }

    const run = await sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: "act_1" })
    expect(run?.writeback?.status).toBe("failed")
    expect(
      await findActionEditCommit({ storage: sixb.storage, projectId: sixb.id, runId: "act_1" })
    ).toBeNull()
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("old")
  })

  test("exposes immutable blob operations inside action writeback", async () => {
    const persistPayload = defineAction("persistPayload")
      .params({})
      .writeback(async ({ sixb, signal }) => {
        const fileRef = await sixb.blobs.put({
          body: new TextEncoder().encode("action payload"),
          expectedSizeBytes: 14,
          signal,
          fileName: "payload.txt",
          mediaType: "text/plain",
        })
        const stat = await sixb.blobs.stat(fileRef.blobId)
        const content = await new Response(await sixb.blobs.open(fileRef.blobId)).text()

        return { fileRef, stat, content }
      })

    const sixb = createSixb([persistPayload])
    await queueActionRun(sixb, {
      id: "act_blob",
      actionId: "persistPayload",
      subject: { kind: "none" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_blob",
        actionId: "persistPayload",
      },
    })

    expect(result.status).toBe("succeeded")
    const run = await sixb.storage.actionRuns!.getById({
      projectId: sixb.id,
      id: "act_blob",
    })
    expect(run?.writeback?.result).toMatchObject({
      content: "action payload",
      fileRef: {
        fileName: "payload.txt",
        mediaType: "text/plain",
        sizeBytes: 14,
      },
      stat: {
        sizeBytes: 14,
      },
    })
  })

  test("skips duplicate terminal run ids without invoking phases twice", async () => {
    let invoked = 0
    const count = defineAction("count")
      .on(Device)
      .params({})
      .writeback(() => {
        invoked += 1
      })

    const sixb = createSixb([count])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    const context = createContext(sixb)
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "count",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    await runActionJob({
      runtime: context,
      job: {
        id: "act_1",
        actionId: "count",
      },
    })

    const duplicate = await runActionJob({
      runtime: context,
      job: {
        id: "act_1",
        actionId: "count",
      },
    })

    expect(invoked).toBe(1)
    expect("skipped" in duplicate).toBe(true)
  })

  test("commits global action edits without loading a target", async () => {
    const createDevice = defineAction("createDevice")
      .params({ id: param("string") })
      .edits(({ objects, params, signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        objects(Device).create({
          id: params.id,
          name: "Created Device",
          status: "created",
        })
      })

    const sixb = createSixb([createDevice])
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "createDevice",
      subject: { kind: "none" },
      params: { id: "device-1" },
    })
    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "createDevice",
      },
    })

    expect(result.status).toBe("succeeded")
    const run = await sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: "act_1" })
    expect(run?.subject).toEqual({ kind: "none" })

    const created = await deviceObjects(sixb).get("device-1")
    expect(created?.properties.status).toBe("created")
  })

  test("separates an independent create from a later managed patch", async () => {
    const createDevice = defineAction("createDevice")
      .params({ id: param("string"), name: param("string") })
      .edits(({ objects, params }) => {
        objects(Device).create({ id: params.id, name: params.name, status: "created" })
      })
    const renameDevice = defineAction("renameDevice")
      .params({ id: param("string"), name: param("string") })
      .edits(({ objects, params }) => {
        objects(Device).byId(params.id).update({ name: params.name, status: "updated" })
      })
    const sixb = createSixb([createDevice as ActionDefinition, renameDevice as ActionDefinition])

    await queueActionRun(sixb, {
      id: "act_create",
      actionId: "createDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Device 1" },
    })
    const created = await runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_create", actionId: "createDevice" },
    })

    await queueActionRun(sixb, {
      id: "act_rename",
      actionId: "renameDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Renamed Device" },
    })
    const updated = await runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_rename", actionId: "renameDevice" },
    })

    expect(created.status).toBe("succeeded")
    expect(updated.status).toBe("succeeded")
    const commits = await Promise.all(
      ["act_create", "act_rename"].map((runId) =>
        findActionEditCommit({ storage: sixb.storage, projectId: sixb.id, runId })
      )
    )
    expect(commits.map((commit) => commit?.changes.objects[0]?.kind)).toEqual([
      "created",
      "updated",
    ])
    expect((await deviceObjects(sixb).get("device-1"))?.properties).toMatchObject({
      id: "device-1",
      name: "Renamed Device",
      status: "updated",
    })

    const mutationEvents = await sixb.events.read({
      types: ["object.created", "object.updated"],
    })
    expect(mutationEvents.map((event) => event.type)).toEqual(["object.created", "object.updated"])
  })

  test("reassigns and clears a cardinality-one link from observed state", async () => {
    const assignSensor = defineAction("assignSensor")
      .on(Device)
      .params({ sensorId: param("string") })
      .edits(async ({ objects, read, params, subject }) => {
        const device = objects(Device).byId(subject.primaryId)
        const current = await read
          .objects(Device)
          .byId(subject.primaryId)
          .listLinks(Device.l.sensor)
        for (const linkRow of current) {
          device.unlink(Device.l.sensor, {
            objectTypeId: Sensor.id,
            primaryId: linkRow.targetId,
          })
        }
        device.link(Device.l.sensor, { objectTypeId: Sensor.id, primaryId: params.sensorId })
      })
    const clearSensor = defineAction("clearSensor")
      .on(Device)
      .params({})
      .edits(async ({ objects, read, subject }) => {
        const device = objects(Device).byId(subject.primaryId)
        for (const linkRow of await read
          .objects(Device)
          .byId(subject.primaryId)
          .listLinks(Device.l.sensor)) {
          device.unlink(Device.l.sensor, {
            objectTypeId: Sensor.id,
            primaryId: linkRow.targetId,
          })
        }
      })
    const sixb = createSixb(
      [assignSensor as ActionDefinition, clearSensor as ActionDefinition],
      [Device, Sensor]
    )
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await sixb.objects.upsert("Sensor", { id: "sensor-1", name: "Sensor 1" })
    await sixb.objects.upsert("Sensor", { id: "sensor-2", name: "Sensor 2" })
    await (
      sixb as unknown as {
        objects(objectType: typeof Device): {
          byId(id: string): {
            link(
              linkToken: typeof Device.l.sensor,
              target: { objectTypeId: "Sensor"; primaryId: string }
            ): Promise<void>
          }
        }
      }
    )
      .objects(Device)
      .byId("device-1")
      .link(Device.l.sensor, { objectTypeId: "Sensor", primaryId: "sensor-1" })

    await queueActionRun(sixb, {
      id: "act_assign_sensor",
      actionId: "assignSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: { sensorId: "sensor-2" },
    })
    expect(
      (
        await runActionJob({
          runtime: createContext(sixb),
          job: { id: "act_assign_sensor", actionId: "assignSensor" },
        })
      ).status
    ).toBe("succeeded")
    let links = await sixb.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Device",
      objectId: "device-1",
      linkId: "sensor",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("sensor-2")

    const assignmentEvents = await sixb.events.read({
      types: ["link.created", "link.deleted"],
    })
    expect(assignmentEvents.slice(-2).map((event) => event.type)).toEqual([
      "link.created",
      "link.deleted",
    ])

    await queueActionRun(sixb, {
      id: "act_clear_sensor",
      actionId: "clearSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })
    expect(
      (
        await runActionJob({
          runtime: createContext(sixb),
          job: { id: "act_clear_sensor", actionId: "clearSensor" },
        })
      ).status
    ).toBe("succeeded")
    links = await sixb.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Device",
      objectId: "device-1",
      linkId: "sensor",
    })
    expect(links).toEqual([])
  })

  test("exposes object link reads inside action edits", async () => {
    const detachSensor = defineAction("detachSensor")
      .on(Device)
      .params({})
      .edits(async ({ objects, read, subject }) => {
        const links = await read.objects(Device).byId(subject.primaryId).listLinks(Device.l.sensor)
        expect(links).toHaveLength(1)
        expect(links[0]).toMatchObject({
          linkId: "sensor",
          targetTypeId: "Sensor",
          targetId: "sensor-1",
        })

        objects(Device).byId(subject.primaryId).unlink(Device.l.sensor, {
          objectTypeId: Sensor.id,
          primaryId: links[0].targetId,
        })
        objects(Device).byId(subject.primaryId).update({ status: "detached" })
      })

    const sixb = createSixb([detachSensor], [Device, Sensor])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await sixb.objects.upsert("Sensor", {
      id: "sensor-1",
      name: "Sensor 1",
    })
    await (
      sixb as unknown as {
        objects(objectType: typeof Device): {
          byId(id: string): {
            link(
              linkToken: typeof Device.l.sensor,
              target: { objectTypeId: "Sensor"; primaryId: string }
            ): Promise<void>
          }
        }
      }
    )
      .objects(Device)
      .byId("device-1")
      .link(Device.l.sensor, { objectTypeId: "Sensor", primaryId: "sensor-1" })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "detachSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "detachSensor",
      },
    })

    expect(result.status).toBe("succeeded")
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("detached")
    const linksAfter = await sixb.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Device",
      objectId: "device-1",
      linkId: "sensor",
    })
    expect(linksAfter).toEqual([])
  })

  test("exposes object reads inside action writeback", async () => {
    // The writeback phase must be able to enrich its external payload from
    // related objects (here: the linked Sensor) before the edit batch exists.
    const captureSensorName = defineAction("captureSensorName")
      .on(Device)
      .params({})
      .writeback(async ({ read, target }) => {
        const links = await read.objects(Device).byId(target.primaryId).listLinks(Device.l.sensor)
        const sensor = await read.objects(Sensor).byId(links[0].targetId).get()
        return { sensorName: String(sensor?.properties.name ?? "unknown") }
      })
      .edits(({ objects, subject, writeback }) => {
        objects(Device).byId(subject.primaryId).update({ status: writeback.sensorName })
      })

    const sixb = createSixb([captureSensorName], [Device, Sensor])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await sixb.objects.upsert("Sensor", {
      id: "sensor-1",
      name: "Sensor 1",
    })
    await (
      sixb as unknown as {
        objects(objectType: typeof Device): {
          byId(id: string): {
            link(
              linkToken: typeof Device.l.sensor,
              target: { objectTypeId: "Sensor"; primaryId: string }
            ): Promise<void>
          }
        }
      }
    )
      .objects(Device)
      .byId("device-1")
      .link(Device.l.sensor, { objectTypeId: "Sensor", primaryId: "sensor-1" })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "captureSensorName",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "captureSensorName",
      },
    })

    expect(result.status).toBe("succeeded")
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("Sensor 1")
  })

  test("fences a writeback read against a change made before the commit", async () => {
    // A writeback handler that reads state, calls an external system, and then commits must not
    // succeed against state that changed while the external call was in flight. The read is of a
    // non-subject object, so only the writeback recorder can catch it.
    let duringExternalCall: (() => Promise<void>) | null = null
    const captureSensorName = defineAction("captureSensorName")
      .on(Device)
      .params({})
      .writeback(async ({ read, target }) => {
        const links = await read.objects(Device).byId(target.primaryId).listLinks(Device.l.sensor)
        const sensor = await read.objects(Sensor).byId(links[0].targetId).get()
        await duringExternalCall?.()
        return { sensorName: String(sensor?.properties.name ?? "unknown") }
      })
      .edits(({ objects, subject, writeback }) => {
        objects(Device).byId(subject.primaryId).update({ status: writeback.sensorName })
      })

    const sixb = createSixb([captureSensorName], [Device, Sensor])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await sixb.objects.upsert("Sensor", { id: "sensor-1", name: "Sensor 1" })
    await (
      sixb as unknown as {
        objects(objectType: typeof Device): {
          byId(id: string): {
            link(
              linkToken: typeof Device.l.sensor,
              target: { objectTypeId: "Sensor"; primaryId: string }
            ): Promise<void>
          }
        }
      }
    )
      .objects(Device)
      .byId("device-1")
      .link(Device.l.sensor, { objectTypeId: "Sensor", primaryId: "sensor-1" })

    duringExternalCall = async () => {
      await sixb.objects.upsert("Sensor", { id: "sensor-1", name: "Renamed mid-run" })
    }

    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "captureSensorName",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_1", actionId: "captureSensorName" },
    })

    expect(result.status).toBe("failed")
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBeUndefined()
  })

  test("marks queued runs failed when the action definition is missing", async () => {
    const sixb = createSixb([])
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "missingAction",
      subject: { kind: "none" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "missingAction",
      },
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error.message).toBe("[SixbActionWorker] Unknown action 'missingAction'.")
      expect(result.error.phase).toBe("validation")
    }
    const run = await sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: "act_1" })
    expect(run?.status).toBe("failed")
    expect(run?.phase).toBe("validation")
  })

  test("reports a lease-loss failure once and not on terminal redelivery", async () => {
    let invoked = 0
    const count = defineAction("count")
      .params({})
      .writeback(() => {
        invoked += 1
      })

    const sixb = createSixb([count])
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "count",
      subject: { kind: "none" },
      params: {},
    })
    await sixb.storage.actionRuns!.start({
      projectId: sixb.id,
      id: "act_1",
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "count",
      },
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error.name).toBe("ActionRunLeaseLostError")
      expect(result.error.phase).toBe("validation")
    }
    expect(invoked).toBe(0)

    const run = await sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: "act_1" })
    expect(run?.status).toBe("failed")
    expect(run?.phase).toBe("validation")
    expect(run?.finishedAt).toBeInstanceOf(Date)

    const redelivered = await runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_1", actionId: "count" },
      attempt: 2,
    })
    expect("skipped" in redelivered && redelivered.skipped).toBe(true)
    await reporter.flush()
    expect(reportCount).toBe(1)
  })

  test("resumes from a persisted successful writeback without replaying it", async () => {
    let writebackCalls = 0
    const setStatus = defineAction("setStatus")
      .on(Device)
      .params({})
      .writeback(() => {
        writebackCalls += 1
        return { status: "from-writeback" }
      })
      .edits(({ objects, subject, writeback }) => {
        objects(Device).byId(subject.primaryId).update({ status: writeback.status })
      })

    const sixb = createSixb([setStatus])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })
    await sixb.storage.actionRuns!.start({ projectId: sixb.id, id: "act_1" })
    await sixb.storage.actionRuns!.recordWriteback({
      projectId: sixb.id,
      id: "act_1",
      status: "succeeded",
      result: { status: "persisted" },
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "setStatus",
      },
    })

    expect(result.status).toBe("succeeded")
    expect(writebackCalls).toBe(0)
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("persisted")
  })

  test("resumes after its committed edits deleted the Action subject", async () => {
    const deleteDevice = defineAction("deleteDevice")
      .on(Device)
      .params({})
      .edits(({ objects, subject }) => {
        objects(Device).byId(subject.primaryId).delete()
      })
    const sixb = createSixb([deleteDevice])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await queueActionRun(sixb, {
      id: "act_delete",
      actionId: "deleteDevice",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })
    await sixb.storage.actionRuns!.start({ projectId: sixb.id, id: "act_delete" })
    await getOntologyMutationRuntime(sixb).commitEdits({
      mode: "atomic",
      source: { kind: "action", actionId: "deleteDevice", runId: "act_delete" },
      operations: [
        {
          id: "delete-subject",
          kind: "object.delete",
          ref: { objectTypeId: "Device", primaryId: "device-1" },
        },
      ],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })

    const resumed = await runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_delete", actionId: "deleteDevice" },
      attempt: 2,
    })

    expect(resumed.status).toBe("succeeded")
    expect(await deviceObjects(sixb).get("device-1")).toBeNull()
  })

  test("records effects errors without failing committed actions", async () => {
    const setStatus = defineAction("setStatus")
      .on(Device)
      .params({})
      .edits(({ objects, subject }) => {
        objects(Device).byId(subject.primaryId).update({ status: "ready" })
      })
      .effects(() => {
        throw new Error("notification failed")
      })

    const sixb = createSixb([setStatus])
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "setStatus",
      },
    })

    expect(result.status).toBe("succeeded")
    const run = await sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: "act_1" })
    expect(run?.status).toBe("succeeded")
    expect(run?.effects).toMatchObject({
      status: "failed",
      error: {
        name: "Error",
        message: "notification failed",
        phase: "effects",
      },
    })
    await reporter.flush()
    expect(reportCount).toBe(0)
  })

  test("does not report cancelled runs", async () => {
    let enteredWriteback: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      enteredWriteback = resolve
    })
    const waitForCancel = defineAction("waitForCancel")
      .params({})
      .writeback(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            enteredWriteback?.()
            signal.addEventListener(
              "abort",
              () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
              { once: true }
            )
          })
      )
    const sixb = createSixb([waitForCancel])
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })
    await queueActionRun(sixb, {
      id: "act_cancelled",
      actionId: "waitForCancel",
      subject: { kind: "none" },
      params: {},
    })
    const controller = new AbortController()

    const execution = runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_cancelled", actionId: "waitForCancel" },
      signal: controller.signal,
      attempt: 1,
    })
    await entered
    controller.abort(new Error("worker stopping"))
    const result = await execution

    expect(result.status).toBe("cancelled")
    await reporter.flush()
    expect(reportCount).toBe(0)
  })

  test("rejects forged object subjects outside the action target hierarchy", async () => {
    let invoked = 0
    const setStatus = defineAction("setStatus")
      .on(Device)
      .params({})
      .writeback(() => {
        invoked += 1
      })

    const sixb = createSixb([setStatus], [Device, Sensor])
    await sixb.objects.upsert("Sensor", {
      id: "sensor-1",
      name: "Sensor 1",
    })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Sensor", primaryId: "sensor-1" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "setStatus",
      },
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error.message).toBe(
        "[SixbActionWorker] Action 'setStatus' is not valid for object type 'Sensor'."
      )
      expect(result.error.phase).toBe("validation")
    }
    expect(invoked).toBe(0)
  })
})
