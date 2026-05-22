import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
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
  Pario,
  prop,
} from "@pario/core"
import { type ActionWorkerContext, runActionJob } from "../src"

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
  get(id: string): Promise<{ properties: Record<string, unknown> } | null>
}

interface TestPario {
  readonly id: string
  readonly events: EventsRuntime
  readonly storage: InMemoryStorage
  upsertObject(objectTypeId: string, properties: Record<string, unknown>): Promise<ObjectRow>
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

function createContext(pario: TestPario): ActionWorkerContext {
  return {
    id: pario.id,
    events: pario.events,
    storage: pario.storage,
    actionRunsStorage: pario.storage.actionRuns!,
    pario: pario as unknown as ActionWorkerContext["pario"],
    getActionById(actionId) {
      return pario.getActionById(actionId)
    },
  }
}

describe("runActionJob", () => {
  test("runs the handler, applies object writes, and stores a succeeded run", async () => {
    const setStatus = defineAction("setStatus")
      .target(Device)
      .params({ status: actionParam("string", { required: true }) })
      .run(async ({ params, target, pario, signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        await pario.objects(Device).upsert({
          properties: {
            id: target.primaryId,
            name: target.properties.name,
            status: params.status,
          },
        })
      })

    const pario = createPario([setStatus])
    await pario.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })

    const result = await runActionJob({
      runtime: createContext(pario),
      job: {
        id: "act_1",
        actionId: "setStatus",
        objectTypeId: "Device",
        primaryId: "device-1",
        params: { status: "ready" },
      },
    })

    expect(result.status).toBe("succeeded")
    const run = await pario.storage.actionRuns!.getById({ projectId: pario.id, id: "act_1" })
    expect(run?.status).toBe("succeeded")
    expect(run?.params).toEqual({ status: "ready" })

    const updated = await deviceObjects(pario).get("device-1")
    expect(updated?.properties.status).toBe("ready")
  })

  test("preserves partial object writes when the handler throws", async () => {
    const failAfterWrite = defineAction("failAfterWrite")
      .target(Device)
      .params({})
      .run(async ({ target, pario }) => {
        await pario.objects(Device).upsert({
          properties: {
            id: target.primaryId,
            name: target.properties.name,
            status: "partially-updated",
          },
        })
        throw new Error("external API failed")
      })

    const pario = createPario([failAfterWrite])
    await pario.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })

    const result = await runActionJob({
      runtime: createContext(pario),
      job: {
        id: "act_1",
        actionId: "failAfterWrite",
        objectTypeId: "Device",
        primaryId: "device-1",
        params: {},
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

    const updated = await deviceObjects(pario).get("device-1")
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

    const pario = createPario([count])
    await pario.upsertObject("Device", {
      id: "device-1",
      name: "Device 1",
    })
    const context = createContext(pario)

    await runActionJob({
      runtime: context,
      job: {
        id: "act_1",
        actionId: "count",
        objectTypeId: "Device",
        primaryId: "device-1",
        params: {},
      },
    })

    const duplicate = await runActionJob({
      runtime: context,
      job: {
        id: "act_1",
        actionId: "count",
        objectTypeId: "Device",
        primaryId: "device-1",
        params: {},
      },
    })

    expect(invoked).toBe(1)
    expect("skipped" in duplicate).toBe(true)
  })
})
