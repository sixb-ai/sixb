import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  type ActionRunRecord,
  type Broker,
  defineAction,
  defineObjectType,
  EventsRuntime,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  LOGS_STREAM,
  type ObjectRow,
  param,
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
      .on(Device)
      .params({})
      .writeback(() => {})
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
            return actionId === "noop" ? noop : null
          },
        })
    ).toThrow(ActionWorkerError)
  })

  test("streams a run-scoped log line to the broker", async () => {
    const noteStatus = defineAction("noteStatus")
      .on(Device)
      .params({ status: param("string") })
      .writeback((ctx) => {
        ctx.logger.info("Applying status", { status: ctx.params.status })
      })

    const sixb = createSixb([noteStatus])
    const worker = new ActionWorker(sixb)
    await sixb.upsertObject("Device", { id: "device-1", name: "Device 1" })

    await worker.start()
    const { runId } = await deviceObjects(sixb).requestAction({
      id: "device-1",
      actionId: "noteStatus",
      params: { status: "active" },
    })

    await waitFor(
      () => sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: runId }),
      (value) => value?.status === "succeeded" || value?.status === "failed"
    )
    await worker.stop()

    const broker = (sixb as unknown as { readonly broker: Broker }).broker
    const { records } = await broker.read({
      projectId: sixb.id,
      streamId: LOGS_STREAM.id,
      names: ["action.info"],
    })
    const line = records.find(
      (record) => (record.payload as { message?: string }).message === "Applying status"
    )
    expect(line?.key).toBe(`action:${runId}`)
    const payload = line?.payload as {
      level: string
      fields?: { status?: string }
      context?: { run?: { kind?: string; id?: string }; phase?: string }
    }
    expect(payload.level).toBe("info")
    expect(payload.fields?.status).toBe("active")
    expect(payload.context?.phase).toBe("writeback")
    expect(payload.context?.run).toEqual({ kind: "action", id: runId })
  })

  test("date/timestamp params arrive as Date objects in handlers", async () => {
    const observed: { dueDate: unknown; day: unknown }[] = []
    const setDue = defineAction("setDue")
      .on(Device)
      .params({ dueDate: param("timestamp"), day: param("date") })
      .writeback((ctx) => {
        observed.push({ dueDate: ctx.params.dueDate, day: ctx.params.day })
        // Typed as Date, so this must not throw at runtime.
        return { iso: ctx.params.dueDate.toISOString() }
      })

    const sixb = createSixb([setDue])
    const worker = new ActionWorker(sixb)
    await sixb.upsertObject("Device", { id: "device-1", name: "Device 1" })

    await worker.start()
    const { runId } = await deviceObjects(sixb).requestAction({
      id: "device-1",
      actionId: "setDue",
      params: {
        dueDate: new Date("2026-06-20T12:34:56.000Z"),
        day: new Date("2026-06-20T12:34:56.000Z"),
      },
    })

    const run = await waitFor(
      () => sixb.storage.actionRuns!.getById({ projectId: sixb.id, id: runId }),
      (value) => value?.status === "succeeded" || value?.status === "failed"
    )
    expect(run?.status).toBe("succeeded")
    const seen = observed[0]
    expect(seen?.dueDate).toBeInstanceOf(Date)
    expect(seen?.day).toBeInstanceOf(Date)
    expect((seen?.dueDate as Date).toISOString()).toBe("2026-06-20T12:34:56.000Z")

    await worker.stop()
  })

  test("claims requested action runs and emits action.completed", async () => {
    const setStatus = defineAction("setStatus")
      .on(Device)
      .params({ status: param("string") })
      .edits(({ objects, params, subject }) => {
        objects(Device).byId(subject.primaryId).update({ status: params.status })
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
      .on(Device)
      .params({ status: param("string") })
      .edits(({ objects, params, subject }) => {
        objects(Device).byId(subject.primaryId).update({ status: params.status })
      })
    const fail = defineAction("fail")
      .on(Device)
      .params({})
      .writeback(() => {
        throw new Error("writeback failed")
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
    expect(failed.error?.message).toBe("writeback failed")

    await worker.stop()
  })
})

function createStorageWithoutActionRuns(): Storage {
  return Object.assign(new InMemoryStorage(), {
    actionRuns: undefined,
  })
}
