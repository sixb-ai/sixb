import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  type ActionRunParams,
  type ActionSubject,
  actionParam,
  defineAction,
  defineObjectType,
  type EventsRuntime,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type ObjectRow,
  prop,
  Sixb,
} from "@sixb/core"
import { type ActionWorkerContext, ActionWorkerError, runActionJob } from "../src"

const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("status", "string"),
  ],
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
      .run(() => {})
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

  test("runs the handler, applies object writes, and stores a succeeded run", async () => {
    const setStatus = defineAction("setStatus")
      .target(Device)
      .params({ status: actionParam("string", { required: true }) })
      .run(async ({ params, target, sixb, signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        await sixb.objects(Device).upsert({
          properties: {
            id: target.primaryId,
            name: target.properties.name,
            status: params.status,
          },
        })
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
    expect(run?.params).toEqual({ status: "ready" })

    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("ready")
  })

  test("preserves partial object writes when the handler throws", async () => {
    const failAfterWrite = defineAction("failAfterWrite")
      .target(Device)
      .params({})
      .run(async ({ target, sixb }) => {
        await sixb.objects(Device).upsert({
          properties: {
            id: target.primaryId,
            name: target.properties.name,
            status: "partially-updated",
          },
        })
        throw new Error("external API failed")
      })

    const sixb = createSixb([failAfterWrite])
    await sixb.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await queueActionRun(sixb, {
      id: "act_1",
      actionId: "failAfterWrite",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runActionJob({
      runtime: createContext(sixb),
      job: {
        id: "act_1",
        actionId: "failAfterWrite",
      },
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error).toEqual({
        name: "Error",
        message: "external API failed",
        phase: "handler",
      })
    }

    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("partially-updated")
  })

  test("skips duplicate run ids without invoking the handler twice", async () => {
    let invoked = 0
    const count = defineAction("count")
      .target(Device)
      .params({})
      .run(() => {
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

  test("runs global action handlers without loading a target", async () => {
    const createDevice = defineAction("createDevice")
      .params({ id: actionParam("string", { required: true }) })
      .run(async ({ params, sixb, signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        await sixb.objects(Device).upsert({
          properties: {
            id: params.id,
            name: "Created Device",
            status: "created",
          },
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
    }
    const run = await sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: "act_1" })
    expect(run?.status).toBe("failed")
    expect(run?.phase).toBe("handler")
  })

  test("marks redelivered running runs failed without invoking the handler again", async () => {
    let invoked = 0
    const count = defineAction("count")
      .params({})
      .run(() => {
        invoked += 1
      })

    const sixb = createSixb([count])
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
      expect(result.error.phase).toBe("handler")
    }
    expect(invoked).toBe(0)

    const run = await sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: "act_1" })
    expect(run?.status).toBe("failed")
    expect(run?.phase).toBe("handler")
    expect(run?.finishedAt).toBeInstanceOf(Date)
  })

  test("rejects forged object subjects outside the action target hierarchy", async () => {
    let invoked = 0
    const setStatus = defineAction("setStatus")
      .target(Device)
      .params({})
      .run(() => {
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
    }
    expect(invoked).toBe(0)
  })
})
