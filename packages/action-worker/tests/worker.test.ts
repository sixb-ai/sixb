import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  ActionRunFailedError,
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
  Pario,
  prop,
} from "@pario/core"
import { ActionWorker } from "../src"
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
  }): Promise<{ runId: string }>
}

interface TestPario {
  readonly id: string
  readonly events: EventsRuntime
  readonly storage: InMemoryStorage
  upsertObject(objectTypeId: string, properties: Record<string, unknown>): Promise<ObjectRow>
  getActionDefinitions(): readonly ActionDefinition[]
  getActionById(actionId: string): ActionDefinition | null
}

const ParioConstructor = Pario as unknown as new (options: Record<string, unknown>) => TestPario

function deviceObjects(pario: TestPario): DeviceObjectSet {
  return (pario as unknown as { objects(objectType: typeof Device): DeviceObjectSet }).objects(
    Device
  )
}

function createPario(actions: readonly ActionDefinition[]): TestPario {
  return new ParioConstructor({
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
    const storage = new InMemoryStorage()
    const worker = new ActionWorker({
      id: "idle-project",
      events: new EventsRuntime({ projectId: "idle-project", broker: new InMemoryBroker() }),
      storage: {
        objects: storage.objects,
        timeseries: storage.timeseries,
      },
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

  test("subscribes to action.requested and emits action.completed", async () => {
    const setStatus = defineAction("setStatus")
      .target(Device)
      .params({ status: actionParam("string", { required: true }) })
      .run(async ({ params, target, pario }) => {
        await pario.objects(Device).upsert({
          properties: {
            id: target.primaryId,
            name: target.properties.name,
            status: params.status,
          },
        })
      })

    const pario = createPario([setStatus])
    const worker = new ActionWorker(pario)
    await pario.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })

    await worker.start()
    const { runId } = await deviceObjects(pario).requestAction({
      id: "device-1",
      actionId: "setStatus",
      params: { status: "ready" },
    })

    const run = await waitFor(
      () => pario.storage.actionRuns!.getById({ projectId: pario.id, id: runId }),
      (value) => value?.status === "succeeded"
    )
    expect(run?.actionId).toBe("setStatus")

    const events = await waitFor(
      () => pario.events.read({ types: ["action.completed"] }),
      (value) => value.length === 1
    )
    expect(events[0]).toMatchObject({
      type: "action.completed",
      idempotencyKey: `action.completed:${runId}`,
      payload: {
        actionId: "setStatus",
        runId,
        objectTypeId: "Device",
        primaryId: "device-1",
      },
    })

    await worker.stop()
  })

  test("requestActionAndWait resolves on completion and rejects on failed runs", async () => {
    const setStatus = defineAction("setStatus")
      .target(Device)
      .params({ status: actionParam("string", { required: true }) })
      .run(async ({ params, target, pario }) => {
        await pario.objects(Device).upsert({
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

    const pario = createPario([setStatus, fail])
    const worker = new ActionWorker(pario)
    await pario.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })

    await worker.start()

    const succeeded = await deviceObjects(pario).requestActionAndWait({
      id: "device-1",
      actionId: "setStatus",
      params: { status: "ready" },
    })
    expect(succeeded.runId.startsWith("act_")).toBe(true)

    await expect(
      deviceObjects(pario).requestActionAndWait({
        id: "device-1",
        actionId: "fail",
      })
    ).rejects.toBeInstanceOf(ActionRunFailedError)

    await worker.stop()
  })
})
