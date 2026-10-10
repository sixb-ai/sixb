import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
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
  param,
  prop,
  type SixbErrorContext,
  SixbHost,
  type Storage,
} from "@sixb/core"
import { attachSixbErrorReporter } from "@sixb/core/internal/error-reporting"
import { LOGS_STREAM } from "@sixb/core/internal/logging"
import {
  type DecisionModel,
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelStreamEvent,
  question,
} from "@sixb/core/models"
import { type ActionRunParams, type ActionRunRecord, isTerminalActionRun } from "@sixb/core/storage"
import { createTestSixb, queueTestActionRun } from "@sixb/core/testing"
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

/**
 * Queue a run and its job, as requests did before they ran Actions in the requesting process.
 * `request` no longer enqueues, so this is how work still reaches the worker.
 */
async function enqueueActionRun(
  host: SixbHost,
  input: {
    readonly actionId: string
    readonly primaryId: string
    readonly params?: ActionRunParams
  }
): Promise<string> {
  const runId = `act_${randomUUID()}`
  const subject: ActionSubject = {
    kind: "object",
    objectTypeId: "Device",
    primaryId: input.primaryId,
  }
  await queueTestActionRun(host.storage, {
    projectId: host.id,
    id: runId,
    actionId: input.actionId,
    subject,
    params: input.params ?? {},
    idempotencyKey: `action:${host.id}:${runId}`,
  })
  await host.queues.actions.enqueue({
    projectId: host.id,
    jobs: [{ id: runId, type: "action.run.requested", payload: { runId } }],
  })
  return runId
}

async function waitForTerminalRun(host: SixbHost, runId: string): Promise<ActionRunRecord> {
  const run = await waitFor(
    () => host.storage.actionRuns!.getById({ projectId: host.id, id: runId }),
    (value) => value !== null && isTerminalActionRun(value)
  )
  if (!run) throw new Error(`Action run '${runId}' was not stored.`)
  return run
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
  test("persists decision writeback and accounts under the action attempt", async () => {
    // Removal proof: omit the decision facade or its accounting call; this path fails.
    const questions = {
      status: question.choice({
        instructions: "Operational status?",
        options: { ready: "Operational", blocked: "Unusable" },
      }),
    }
    const model: DecisionModel = {
      providerId: "test",
      modelId: "decision",
      definition: {
        kind: "decision",
        providerId: "test",
        modelId: "decision",
        capabilities: { questions: ["choice"] },
      },
      evaluate: async () => ({
        output: { status: { choice: "ready", probabilities: { ready: 1, blocked: 0 } } },
        usage: { inputTokens: 6, outputTokens: 4 },
      }),
    }
    const action = defineAction("decide-status")
      .on(Device)
      .params({})
      .writeback(
        async ({ sixb }) =>
          (await sixb.models.decision.evaluate({ model, input: "Repaired", questions })).output
      )
      .edits(({ objects, subject, writeback }) => {
        objects(Device).byId(subject.primaryId).update({ status: writeback.status.choice })
      })
    const { host, sixb } = createSixb([action])
    const worker = new ActionWorker(host)
    await sixb.objects.upsert("Device", { id: "decision-device", name: "Device" })
    await worker.start()
    try {
      const runId = await enqueueActionRun(host, {
        actionId: action.id,
        primaryId: "decision-device",
      })
      const run = await waitForTerminalRun(host, runId)
      expect(run.status).toBe("succeeded")
      expect(run.writeback).toMatchObject({
        status: "succeeded",
        result: { status: { choice: "ready" } },
      })
      expect(
        await host.storage.aiUsage!.getLatestForExecution({
          projectId: host.id,
          executionId: run.executionId,
        })
      ).toMatchObject({ attempt: 1, usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } })
    } finally {
      await worker.stop()
    }
  })

  test("accounts for direct generation in action writeback before persisting the result", async () => {
    // Removal proof: remove models from the Action facade or its worker attempt binding.
    const model: LanguageModel = {
      providerId: "test",
      modelId: "extract",
      definition: defineLanguageModel({
        kind: "language",
        providerId: "test",
        modelId: "extract",
        capabilities: { nativeStructuredOutput: true },
      }),
      async stream() {
        return {
          events: (async function* (): AsyncIterable<LanguageModelStreamEvent> {
            yield { type: "stream-start" }
            yield { type: "text-start", id: "text" }
            yield { type: "text-delta", id: "text", delta: '{"status":"ready"}' }
            yield { type: "text-end", id: "text" }
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 5, outputTokens: 3 },
            }
          })(),
        }
      },
    }
    const action = defineAction("extract-status")
      .on(Device)
      .params({})
      .writeback(async ({ sixb }) => {
        const result = await sixb.models.language.generate({
          model,
          prompt: "Extract status",
          output: { status: "string" },
        })
        return result.output
      })
      .edits(({ objects, subject, writeback }) => {
        objects(Device).byId(subject.primaryId).update({ status: writeback.status })
      })
    const { host, sixb } = createSixb([action])
    const worker = new ActionWorker(host)
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device" })
    await worker.start()
    try {
      const runId = await enqueueActionRun(host, { actionId: action.id, primaryId: "device-1" })
      const run = await waitForTerminalRun(host, runId)
      expect(run.status).toBe("succeeded")
      expect(run.writeback).toMatchObject({ status: "succeeded", result: { status: "ready" } })
      expect(
        await host.storage.aiUsage!.getLatestForExecution({
          projectId: host.id,
          executionId: run.executionId,
        })
      ).toMatchObject({ attempt: 1, requesterGroupIds: [], usage: { totalTokens: 8 } })
    } finally {
      await worker.stop()
    }
  })

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
    const runId = await enqueueActionRun(host, {
      actionId: "noteStatus",
      primaryId: "device-1",
      params: { status: "active" },
    })

    await waitForTerminalRun(host, runId)
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
    // Stored params are JSON, as a request normalized them.
    const runId = await enqueueActionRun(host, {
      actionId: "setDue",
      primaryId: "device-1",
      params: { dueDate: "2026-06-20T12:34:56.000Z", day: "2026-06-20" },
    })

    const run = await waitForTerminalRun(host, runId)
    expect(run.status).toBe("succeeded")
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
    const runId = await enqueueActionRun(host, {
      actionId: "setStatus",
      primaryId: "device-1",
      params: { status: "ready" },
    })

    const run = await waitForTerminalRun(host, runId)
    expect(run).toMatchObject({ actionId: "setStatus", status: "succeeded" })
    const durableExecution = await host.storage.executions.getById({
      projectId: host.id,
      id: run.executionId,
    })

    const events = await waitFor(
      () => host.events.read({ types: ["action.completed"] }),
      (value) => value.length === 1
    )
    expect(events[0]).toMatchObject({
      type: "action.completed",
      correlationId: durableExecution?.correlationId,
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
    const failed = await waitForTerminalRun(
      host,
      await enqueueActionRun(host, { actionId: "fail", primaryId: "device-1" })
    )
    await worker.stop()
    await reporter.flush()

    expect(failed.status).toBe("failed")
    expect(failed.error).toMatchObject({
      code: "action.phase_failed",
      details: { actionId: "fail", runId: failed.id, phase: "writeback" },
    })
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
})

function createStorageWithoutActionRuns(): Storage {
  return Object.assign(new InMemoryStorage(), {
    actionRuns: undefined,
  })
}
