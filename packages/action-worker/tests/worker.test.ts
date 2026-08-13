import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  defineAction,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  param,
  prop,
  type SixbErrorContext,
  SixbHost,
  type Storage,
} from "@sixb/core"
import { attachSixbErrorReporter } from "@sixb/core/internal/error-reporting"
import { LOGS_STREAM } from "@sixb/core/internal/logging"
import type { ActionRunRecord } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { ActionWorker } from "../src"
import type { ActionExecutionFacade } from "../src/types"
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

function deviceObjects(sixb: ActionExecutionFacade): DeviceObjectSet {
  return sixb.objects(Device)
}

function createSixb(
  actions: readonly ActionDefinition[],
  storage: Storage = new InMemoryStorage()
) {
  const host = new SixbHost({
    id: "action-worker-tests",
    ontology: [Device],
    actions,
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  return { host, sixb: createTestSixb(host) }
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback()
  } catch (error) {
    return error
  }
  throw new Error("Expected callback to throw")
}

describe("ActionWorker", () => {
  test("idles without action definitions or action-run storage", async () => {
    const storage = createStorageWithoutActionRuns()
    const worker = new ActionWorker(createSixb([], storage).host)

    await worker.start()
    await worker.stop()
  })

  test("throws a coded internal error when action-run storage is missing", () => {
    const noop = defineAction("noop")
      .on(Device)
      .params({})
      .writeback(() => {})
    const storage = createStorageWithoutActionRuns()

    const error = captureThrown(() => new ActionWorker(createSixb([noop], storage).host))

    expect(error).toMatchObject({
      code: "internal.unexpected",
      message: "[SixbActionWorker] Action workers require storage.actionRuns support.",
      retryable: false,
    })
  })

  test("streams a run-scoped log line to the broker", async () => {
    const noteStatus = defineAction("noteStatus")
      .on(Device)
      .params({ status: param("string") })
      .writeback((ctx) => {
        ctx.logger.info("Applying status", { status: ctx.params.status })
      })

    const { host, sixb } = createSixb([noteStatus])
    const worker = new ActionWorker(host)
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })

    await worker.start()
    const { runId } = await deviceObjects(sixb).requestAction({
      id: "device-1",
      actionId: "noteStatus",
      params: { status: "active" },
    })

    await waitFor(
      () => host.storage.actionRuns!.getById({ projectId: host.id, id: runId }),
      (value) => value?.status === "succeeded" || value?.status === "failed"
    )
    await worker.stop()

    const { records } = await host.broker.read({
      projectId: host.id,
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

    const { host, sixb } = createSixb([setDue])
    const worker = new ActionWorker(host)
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })

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
      () => host.storage.actionRuns!.getById({ projectId: host.id, id: runId }),
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

    const { host, sixb } = createSixb([setStatus])
    const worker = new ActionWorker(host)
    await sixb.objects.upsert("Device", {
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
      () => host.storage.actionRuns!.getById({ projectId: host.id, id: runId }),
      (value) => value?.status === "succeeded"
    )
    expect(run?.actionId).toBe("setStatus")
    const durableExecution = run
      ? await host.storage.executions.getById({ projectId: host.id, id: run.executionId })
      : null
    expect(durableExecution).toMatchObject({
      source: { type: "execution", executionId: sixb.execution.id },
      parentExecutionId: sixb.execution.id,
      correlationId: sixb.execution.correlationId,
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "action", id: "setStatus", runId },
      },
    })

    const events = await waitFor(
      () => host.events.read({ types: ["action.completed"] }),
      (value) => value.length === 1
    )
    expect(events[0]).toMatchObject({
      type: "action.completed",
      correlationId: sixb.execution.correlationId,
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

  test("reports a terminal action failure exactly once with the original error", async () => {
    const originalError = new Error("writeback failed")
    const fail = defineAction("fail")
      .on(Device)
      .params({})
      .writeback(() => {
        throw originalError
      })
    const { host, sixb } = createSixb([fail])
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const reporter = attachSixbErrorReporter(host, (error, context) => {
      reports.push({ error, context })
    })
    const worker = new ActionWorker(host)
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })

    await worker.start()
    const failed = await deviceObjects(sixb).requestActionAndWait({
      id: "device-1",
      actionId: "fail",
    })
    await worker.stop()
    await reporter.flush()

    expect(failed.status).toBe("failed")
    expect(reports).toHaveLength(1)
    expect(reports[0]?.error).toBe(originalError)
    expect(reports[0]?.context).toMatchObject({
      type: "run.failed",
      notificationId: `project:${host.id}:run:action:${failed.id}:failed:${failed.error?.at}`,
      projectId: host.id,
      attempt: 1,
      runKind: "action",
      run: {
        runId: failed.id,
        actionId: "fail",
      },
      failure: failed.error,
    })
    expect(reports[0]?.context.occurredAt).toBe(failed.error?.at ?? "")
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

    const { host, sixb } = createSixb([setStatus, fail])
    const worker = new ActionWorker(host)
    await sixb.objects.upsert("Device", {
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
    expect(failed.error?.message).toBe("An unexpected internal error occurred.")

    await worker.stop()
  })
})

function createStorageWithoutActionRuns(): Storage {
  return Object.assign(new InMemoryStorage(), {
    actionRuns: undefined,
  })
}
