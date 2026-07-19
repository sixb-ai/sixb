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
import { attachSixbErrorReporter } from "@sixb/core/internal/error-reporting"
import type { EventsRuntime } from "@sixb/core/internal/events"
import type { ActionRunParams, ObjectRow } from "@sixb/core/storage"
import { ActionWorkerError } from "../src/errors"
import { runActionJob } from "../src/run-action-job"
import type { ActionWorkerContext } from "../src/types"

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

interface TestSixb {
  readonly id: string
  readonly blobStorage: InMemoryBlobStorage
  readonly events: EventsRuntime
  readonly storage: InMemoryStorage
  upsertObject(objectTypeId: string, properties: Record<string, unknown>): Promise<ObjectRow>
  getActionById(actionId: string): ActionDefinition | null
}

const SixbConstructor = Sixb as unknown as new (options: Record<string, unknown>) => TestSixb

function deviceObjects(sixb: TestSixb): DeviceObjectSet {
  return (sixb as unknown as { objects(objectType: typeof Device): DeviceObjectSet }).objects(
    Device
  )
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
    events: sixb.events,
    storage: sixb.storage,
    actionRunsStorage: sixb.storage.actionRuns!,
    sixb: sixb as unknown as ActionWorkerContext["sixb"],
    getActionById(actionId) {
      return sixb.getActionById(actionId)
    },
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
    await sixb.upsertObject("Device", {
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
    expect(run?.commit?.diff.objects).toEqual([
      {
        objectTypeId: "Device",
        primaryId: "device-1",
        operation: "update",
        changedProperties: ["status"],
      },
    ])

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
    await sixb.upsertObject("Device", {
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
    expect(run?.commit).toBeUndefined()
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
    await sixb.upsertObject("Device", {
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

  test("resolves staged upserts inside the action commit", async () => {
    const syncDevice = defineAction("syncDevice")
      .params({ id: param("string"), name: param("string"), status: param("string") })
      .edits(({ objects, params }) => {
        objects(Device).upsert({
          id: params.id,
          name: params.name,
          status: params.status,
        })
      })
    const sixb = createSixb([syncDevice])

    await queueActionRun(sixb, {
      id: "act_upsert_create",
      actionId: "syncDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Device 1", status: "created" },
    })
    const created = await runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_upsert_create", actionId: "syncDevice" },
    })

    await queueActionRun(sixb, {
      id: "act_upsert_update",
      actionId: "syncDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Renamed Device", status: "updated" },
    })
    const updated = await runActionJob({
      runtime: createContext(sixb),
      job: { id: "act_upsert_update", actionId: "syncDevice" },
    })

    expect(created.status).toBe("succeeded")
    expect(updated.status).toBe("succeeded")
    const createdRun = await sixb.storage.actionRuns!.getById({
      projectId: sixb.id,
      id: "act_upsert_create",
    })
    const updatedRun = await sixb.storage.actionRuns!.getById({
      projectId: sixb.id,
      id: "act_upsert_update",
    })
    expect(createdRun?.commit?.diff.objects[0]?.operation).toBe("create")
    expect(updatedRun?.commit?.diff.objects[0]?.operation).toBe("update")
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

  test("assigns and clears cardinality-one links without handler-side reads", async () => {
    const assignSensor = defineAction("assignSensor")
      .on(Device)
      .params({ sensorId: param("string") })
      .edits(({ objects, params, subject }) => {
        objects(Device)
          .byId(subject.primaryId)
          .setLink(Device.l.sensor, objects(Sensor).byId(params.sensorId))
      })
    const clearSensor = defineAction("clearSensor")
      .on(Device)
      .params({})
      .edits(({ objects, subject }) => {
        objects(Device).byId(subject.primaryId).clearLink(Device.l.sensor)
      })
    const sixb = createSixb(
      [assignSensor as ActionDefinition, clearSensor as ActionDefinition],
      [Device, Sensor]
    )
    await sixb.upsertObject("Device", { id: "device-1", name: "Device 1" })
    await sixb.upsertObject("Sensor", { id: "sensor-1", name: "Sensor 1" })
    await sixb.upsertObject("Sensor", { id: "sensor-2", name: "Sensor 2" })
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
      "link.deleted",
      "link.created",
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
    await sixb.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await sixb.upsertObject("Sensor", {
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
    await sixb.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await sixb.upsertObject("Sensor", {
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
    await sixb.upsertObject("Device", {
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
    await sixb.upsertObject("Device", {
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
    await sixb.upsertObject("Sensor", {
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
