import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  type ActionRunRecord,
  actionParam,
  defineAction,
  defineObjectType,
  EventsRuntime,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type ObjectRow,
  prop,
  Sixb,
  type Storage,
} from "@sixb/core"
import { ActionWorker, ActionWorkerError } from "../src"
import { waitFor } from "./helpers"

const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("status", "string"),
  ],
})

interface DeviceObjectSet {
  upsert(input: { properties: Record<string, unknown> }): Promise<unknown>
  requestAction(input: {
    id: string
    actionId: string
    params?: Record<string, unknown>
  }): Promise<{ runId: string }>
  requestActionAndWait(input: {
    id: string
    actionId: string
    params?: Record<string, unknown>
  }): Promise<ActionRunRecord>
}

interface TestSixb {
  readonly id: string
  readonly events: EventsRuntime
  readonly storage: InMemoryStorage
  readonly queues: InMemoryQueues
  upsertObject(objectTypeId: string, properties: Record<string, unknown>): Promise<ObjectRow>
  getActionDefinitions(): readonly ActionDefinition[]
  getActionById(actionId: string): ActionDefinition | null
}

const SixbConstructor = Sixb as unknown as new (options: Record<string, unknown>) => TestSixb

function deviceObjects(sixb: TestSixb): DeviceObjectSet {
  return (sixb as unknown as { objects(objectType: typeof Device): DeviceObjectSet }).objects(
    Device
  )
}

function createSixb(actions: readonly ActionDefinition[]): TestSixb {
  return new SixbConstructor({
    id: "action-worker-tests",
    ontology: [Device],
    actions,
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

describe("ActionWorker", () => {
  test("idles without action definitions or action-run storage", async () => {
    const storage = createStorageWithoutActionRuns()
    const worker = new ActionWorker({
      id: "idle-project",
      events: new EventsRuntime({ projectId: "idle-project", broker: new InMemoryBroker() }),
      storage,
      queues: new InMemoryQueues(),
      getActionDefinitions() {
        return []
      },
      getActionById() {
        return null
      },
    })

    await worker.start()
    await worker.stop()
  })

  test("throws ActionWorkerError when action-run storage is missing", () => {
    const noop = defineAction("noop")
      .target(Device)
      .params({})
      .run(() => {})
    const storage = createStorageWithoutActionRuns()

    expect(
      () =>
        new ActionWorker({
          id: "missing-action-runs",
          events: new EventsRuntime({
            projectId: "missing-action-runs",
            broker: new InMemoryBroker(),
          }),
          storage,
          queues: new InMemoryQueues(),
          getActionDefinitions() {
            return [noop]
          },
          getActionById(actionId) {
            return actionId === noop.id ? noop : null
          },
        })
    ).toThrow(ActionWorkerError)
  })

  test("claims requested action runs and emits action.completed", async () => {
    const setStatus = defineAction("setStatus")
      .target(Device)
      .params({ status: actionParam("string", { required: true }) })
      .run(async ({ params, target, sixb }) => {
        await sixb.objects(Device).upsert({
          properties: {
            id: target.primaryId,
            name: target.properties.name,
            status: params.status,
          },
        })
      })

    const sixb = createSixb([setStatus])
    const worker = new ActionWorker(sixb)
    await sixb.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })

    await worker.start()
    const { runId } = await deviceObjects(sixb).requestAction({
      id: "device-1",
      actionId: "setStatus",
      params: { status: "ready" },
    })

    const run = await waitFor(
      () => sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: runId }),
      (value) => value?.status === "succeeded"
    )
    expect(run?.actionId).toBe("setStatus")

    const events = await waitFor(
      () => sixb.events.read({ types: ["action.completed"] }),
      (value) => value.length === 1
    )
    expect(events[0]).toMatchObject({
      type: "action.completed",
      idempotencyKey: `action.completed:${runId}`,
      payload: {
        actionId: "setStatus",
        runId,
        subject: {
          kind: "object",
          objectTypeId: "Device",
          primaryId: "device-1",
        },
      },
    })

    await worker.stop()
  })

  test("requestActionAndWait resolves with the terminal action run", async () => {
    const setStatus = defineAction("setStatus")
      .target(Device)
      .params({ status: actionParam("string", { required: true }) })
      .run(async ({ params, target, sixb }) => {
        await sixb.objects(Device).upsert({
          properties: {
            id: target.primaryId,
            name: target.properties.name,
            status: params.status,
          },
        })
      })
    const fail = defineAction("fail")
      .target(Device)
      .params({})
      .run(() => {
        throw new Error("handler failed")
      })

    const sixb = createSixb([setStatus, fail])
    const worker = new ActionWorker(sixb)
    await sixb.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })

    await worker.start()

    const succeeded = await deviceObjects(sixb).requestActionAndWait({
      id: "device-1",
      actionId: "setStatus",
      params: { status: "ready" },
    })
    expect(succeeded.id.startsWith("act_")).toBe(true)
    expect(succeeded.status).toBe("succeeded")

    const failed = await deviceObjects(sixb).requestActionAndWait({
      id: "device-1",
      actionId: "fail",
    })
    expect(failed.status).toBe("failed")
    expect(failed.error?.message).toBe("handler failed")

    await worker.stop()
  })
})

function createStorageWithoutActionRuns(): Storage {
  return Object.assign(new InMemoryStorage(), {
    actionRuns: undefined,
  })
}
