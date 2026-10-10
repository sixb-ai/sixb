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
  type OntologySource,
  param,
  prop,
  type SixbErrorContext,
  SixbHost,
} from "../src"
import { type ActionRunHost, executeActionRun } from "../src/actions/run/execute"
import { runAction, UnrecordedActionRunError } from "../src/actions/run/run-action"
import { ActionRunSignals } from "../src/actions/run/signals"
import type { ActionRunContext, PendingActionRun } from "../src/actions/run/types"
import { attachSixbErrorReporter } from "../src/error-reporting/internal"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import { LOGS_STREAM } from "../src/logging/stream"
import {
  type DecisionModel,
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelStreamEvent,
  question,
} from "../src/models"
import type { ActionRunParams, ActionRunRecord } from "../src/storage"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { createTestActionExecution, createTestSixb, recordTestActionRun } from "../src/testing"

const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("status", "string"),
    prop("temperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    }),
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

function deviceObjects(sixb: ActionRunContext["sixb"]): DeviceObjectSet {
  return sixb.objects(Device)
}

function createSixb(
  actions: readonly ActionDefinition[],
  ontology: readonly OntologySource[] = [Device]
) {
  const host = new SixbHost({
    id: "action-run-tests",
    ontology,
    actions,
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  return { host, sixb: createTestSixb(host) }
}

async function createContext(
  host: ActionRunHost,
  run: PendingActionRun
): Promise<ActionRunContext> {
  const durableExecution = await host.storage.executions.getById({
    projectId: host.id,
    id: run.executionId,
  })
  if (!durableExecution) {
    throw new Error(`Action run '${run.id}' references missing execution '${run.executionId}'.`)
  }
  const primitive = {
    kind: "action" as const,
    id: run.actionId,
    runId: run.id,
  }
  const execution = bindDurablePrimitiveExecution(host, {
    execution: durableExecution,
    primitive,
  })
  return {
    id: host.id,
    errorReporterHost: host,
    events: host.events,
    storage: host.storage,
    actionRunsStorage: host.storage.actionRuns!,
    ontologyMutations: execution.ontologyMutations,
    sixb: {
      models: execution.sixb.models,
      objects: execution.sixb.objects,
      actions: execution.sixb.actions,
      connector: execution.sixb.connector,
      blobs: execution.sixb.blobs,
    },
    actions: host.definitions.actions,
  }
}

/** The runs prepared on each host, as the request that created their execution holds them. */
const preparedRuns = new WeakMap<ActionRunHost, Map<string, PendingActionRun>>()

/** Create a run's execution, as the request that executes the run does first. */
async function prepareActionRun(
  host: ActionRunHost,
  input: {
    readonly id: string
    readonly actionId: string
    readonly subject: ActionSubject
    readonly params: ActionRunParams
  }
): Promise<PendingActionRun> {
  const run: PendingActionRun = {
    ...input,
    projectId: host.id,
    executionId: await createTestActionExecution(host.storage.executions, {
      projectId: host.id,
      actionId: input.actionId,
      runId: input.id,
    }),
    idempotencyKey: `action:${host.id}:${input.id}`,
  }
  const runs = preparedRuns.get(host) ?? new Map<string, PendingActionRun>()
  runs.set(run.id, run)
  preparedRuns.set(host, runs)
  return run
}

/**
 * Execute a prepared run as its request would, then run its effects to their end, and return the
 * run's stored record.
 */
async function executePreparedRun(input: {
  readonly host: ActionRunHost
  readonly runId: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}): Promise<ActionRunRecord> {
  const { host } = input
  const run = preparedRuns.get(host)?.get(input.runId)
  if (!run) throw new Error(`Action run '${input.runId}' was not prepared.`)
  const execution = await host.storage.executions.getById({
    projectId: host.id,
    id: run.executionId,
  })
  if (!execution) throw new Error(`Action run '${run.id}' has no execution.`)

  const outcome = await executeActionRun(host, {
    run,
    execution,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  })
  await outcome.effects?.()
  const stored = await host.storage.actionRuns?.getById({ projectId: host.id, id: run.id })
  if (!stored) throw new Error(`Action run '${run.id}' was not recorded.`)
  return stored
}

/** The edit commit a run produced, or `null` when it committed nothing. */
async function findEditCommit(host: ActionRunHost, runId: string) {
  const commit = await host.storage.ontology.commits.getByOrigin({
    projectId: host.id,
    origin: { kind: "action", actionRunId: runId },
  })
  const result = commit?.result
  if (!result) return null
  if (result.kind !== "edit") {
    throw new Error(`Action run '${runId}' produced a ${result.kind} commit.`)
  }
  return result
}

/** A short deadline for the tests that outlast one. Handlers wait for it, never sleep through it. */
const DEADLINE_MS = 100

/** Resolves once `signal` aborts, so a handler can outlast a deadline without a timed sleep. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

describe("runAction", () => {
  // Restore core's failure codec from HEAD to verify this stored-message assertion fails.
  test.each([
    "type",
    "missing",
  ])("stores a precise %s validation explanation without the rejected value", async (kind) => {
    const invalid = defineAction("invalidEdit")
      .params({})
      .edits(({ objects }) => {
        objects(Device).create({
          id: "device-secret",
          ...(kind === "type" ? { name: 42 } : {}),
        } as unknown as { id: string; name: string })
      })
    const { host } = createSixb([invalid])
    await prepareActionRun(host, {
      id: "invalid-edit",
      actionId: invalid.id,
      subject: { kind: "none" },
      params: {},
    })
    await executePreparedRun({ host, runId: "invalid-edit" })
    const run = await host.storage.actionRuns!.getById({ projectId: host.id, id: "invalid-edit" })
    expect(run?.status).toBe("failed")
    expect(run?.error?.message).toBe(
      kind === "type"
        ? "Action execution failed. Property Device.name must be a string."
        : "Action execution failed. Missing required property 'Device.name'."
    )
    expect(JSON.stringify(run?.error)).not.toContain("device-secret")
  })

  test("rejects a durable run from another project", async () => {
    const count = defineAction("count")
      .params({})
      .writeback(() => {})
    const { host } = createSixb([count])
    const run = await prepareActionRun(host, {
      id: "act_stored",
      actionId: "count",
      subject: { kind: "none" },
      params: {},
    })
    const signals = new ActionRunSignals({ actionId: "count", runId: run.id })

    try {
      await expect(
        runAction({
          runtime: await createContext(host, run),
          run: { ...run, projectId: "other-project" },
          signals,
        })
      ).rejects.toMatchObject({
        code: "internal.unexpected",
        message:
          "[Sixb] Action run 'act_stored' belongs to project 'other-project', not 'action-run-tests'.",
        retryable: false,
        details: { actionId: "count", runId: "act_stored", durableProjectId: "other-project" },
      })
    } finally {
      signals.dispose()
    }
  })

  test("passes nullable params to action handlers unchanged", async () => {
    let received: Date | null = new Date(0)
    const captureNullable = defineAction("captureNullable")
      .params({ reviewedAt: param("timestamp", { nullable: true }) })
      .writeback(({ params }) => {
        received = params.reviewedAt
      })
    const { host } = createSixb([captureNullable])
    await prepareActionRun(host, {
      id: "act_nullable",
      actionId: "captureNullable",
      subject: { kind: "none" },
      params: { reviewedAt: null },
    })

    const result = await executePreparedRun({
      host,
      runId: "act_nullable",
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

    const { host, sixb } = createSixb([setStatus])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: { status: "ready" },
    })

    const result = await executePreparedRun({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("succeeded")
    const run = await host.storage.actionRuns!.getById({ projectId: host.id, id: "act_1" })
    expect(run?.status).toBe("succeeded")
    expect(run?.phase).toBe("commit")
    const commit = await findEditCommit(host, "act_1")
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

    const { host, sixb } = createSixb([failWriteback])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
      status: "old",
    })
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "failWriteback",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.error).toMatchObject({
        code: "action.phase_failed",
        message: "Action execution failed.",
        retryable: false,
        details: { actionId: "failWriteback", runId: "act_1", phase: "writeback" },
      })
      expect(result.error.at).toEqual(expect.any(String))
    }

    const run = await host.storage.actionRuns!.getById({ projectId: host.id, id: "act_1" })
    expect(run?.writeback?.status).toBe("failed")
    expect(await findEditCommit(host, "act_1")).toBeNull()
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("old")
  })

  // Guard proof: return the succeeded record from `recordRun` (`actions/run/run-action.ts`) when
  // writing it fails, and the run resolves as if it had been recorded.
  test("rejects with the record it could not write", async () => {
    const complete = defineAction("complete")
      .params({})
      .writeback(() => ({ ok: true }))
    const { host } = createSixb([complete])
    await prepareActionRun(host, {
      id: "act_unrecorded",
      actionId: "complete",
      subject: { kind: "none" },
      params: {},
    })
    const restore = decorateOperationScopedMethodForTesting(
      host.storage.actionRuns!,
      "record",
      () => async () => {
        throw new Error("record exploded")
      }
    )

    try {
      const failure = await executePreparedRun({ host, runId: "act_unrecorded" }).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(UnrecordedActionRunError)
      expect(failure).toMatchObject({
        record: { status: "succeeded", phase: "writeback", writeback: { result: { ok: true } } },
        cause: { message: "record exploded" },
      })
    } finally {
      restore()
    }
  })

  // Guard proof: refuse every `ActionRunError` from `record` in `recordRun`
  // (`actions/run/run-action.ts`), and this run rejects instead of answering with the record a
  // concurrent request wrote.
  test("answers with the record of a concurrent request that recorded the run first", async () => {
    let writebacks = 0
    const complete = defineAction("complete")
      .params({})
      .writeback(() => {
        writebacks += 1
        return { attempt: writebacks }
      })
    const { host } = createSixb([complete])
    const run = await prepareActionRun(host, {
      id: "act_raced",
      actionId: "complete",
      subject: { kind: "none" },
      params: {},
    })
    // Another process ran the same run id, under an execution of its own, and recorded it first.
    const winner = await recordTestActionRun(host.storage, {
      id: run.id,
      projectId: run.projectId,
      actionId: run.actionId,
      subject: run.subject,
      params: run.params,
      idempotencyKey: run.idempotencyKey,
      phase: "writeback",
      writeback: {
        status: "succeeded",
        completedAt: new Date("2026-01-01T00:00:00.000Z"),
        result: { attempt: 0 },
      },
    })
    // This request runs it again, under the execution it created for it.
    const executionId = await createTestActionExecution(host.storage.executions, {
      projectId: host.id,
      actionId: run.actionId,
      runId: run.id,
      executionId: "exec_second_request",
    })
    const execution = await host.storage.executions.getById({ projectId: host.id, id: executionId })
    if (!execution) throw new Error("The second request's execution is missing.")

    const outcome = await executeActionRun(host, { run: { ...run, executionId }, execution })

    expect(writebacks).toBe(1)
    expect(outcome).toEqual({ record: winner, recorded: false })
  })

  // The request that receives the record checks it, caller first: see `ActionRunExecutor`.
  test("leaves a concurrent record that carries another request to its request to check", async () => {
    const complete = defineAction("complete")
      .params({ amount: param("double") })
      .writeback(() => {})
    const { host } = createSixb([complete])
    const run = await prepareActionRun(host, {
      id: "act_taken",
      actionId: "complete",
      subject: { kind: "none" },
      params: { amount: 1 },
    })
    const winner = await recordTestActionRun(host.storage, {
      id: run.id,
      projectId: run.projectId,
      actionId: run.actionId,
      subject: run.subject,
      params: { amount: 2 },
      idempotencyKey: run.idempotencyKey,
      phase: "writeback",
    })
    const executionId = await createTestActionExecution(host.storage.executions, {
      projectId: host.id,
      actionId: run.actionId,
      runId: run.id,
      executionId: "exec_taken_second",
    })
    const execution = await host.storage.executions.getById({ projectId: host.id, id: executionId })
    if (!execution) throw new Error("The second request's execution is missing.")

    await expect(
      executeActionRun(host, { run: { ...run, executionId }, execution })
    ).resolves.toEqual({ record: winner, recorded: false })
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

    const { host } = createSixb([persistPayload])
    await prepareActionRun(host, {
      id: "act_blob",
      actionId: "persistPayload",
      subject: { kind: "none" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_blob",
    })

    expect(result.status).toBe("succeeded")
    const run = await host.storage.actionRuns!.getById({
      projectId: host.id,
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

    const { host, sixb } = createSixb([createDevice])
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "createDevice",
      subject: { kind: "none" },
      params: { id: "device-1" },
    })
    const result = await executePreparedRun({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("succeeded")
    const run = await host.storage.actionRuns!.getById({ projectId: host.id, id: "act_1" })
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
    const { host, sixb } = createSixb([
      createDevice as ActionDefinition,
      renameDevice as ActionDefinition,
    ])

    await prepareActionRun(host, {
      id: "act_create",
      actionId: "createDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Device 1" },
    })
    const created = await executePreparedRun({
      host,
      runId: "act_create",
    })

    await prepareActionRun(host, {
      id: "act_rename",
      actionId: "renameDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Renamed Device" },
    })
    const updated = await executePreparedRun({
      host,
      runId: "act_rename",
    })

    expect(created.status).toBe("succeeded")
    expect(updated.status).toBe("succeeded")
    const commits = await Promise.all(
      ["act_create", "act_rename"].map((runId) => findEditCommit(host, runId))
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

    const mutationEvents = await host.events.read({
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
    const { host, sixb } = createSixb(
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

    await prepareActionRun(host, {
      id: "act_assign_sensor",
      actionId: "assignSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: { sensorId: "sensor-2" },
    })
    expect(
      (
        await executePreparedRun({
          host,
          runId: "act_assign_sensor",
        })
      ).status
    ).toBe("succeeded")
    let links = await host.storage.objects.listLinks({
      projectId: host.id,
      objectTypeId: "Device",
      objectId: "device-1",
      linkId: "sensor",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("sensor-2")

    const assignmentEvents = await host.events.read({
      types: ["link.created", "link.deleted"],
    })
    expect(assignmentEvents.slice(-2).map((event) => event.type)).toEqual([
      "link.created",
      "link.deleted",
    ])

    await prepareActionRun(host, {
      id: "act_clear_sensor",
      actionId: "clearSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })
    expect(
      (
        await executePreparedRun({
          host,
          runId: "act_clear_sensor",
        })
      ).status
    ).toBe("succeeded")
    links = await host.storage.objects.listLinks({
      projectId: host.id,
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

    const { host, sixb } = createSixb([detachSensor], [Device, Sensor])
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
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "detachSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("succeeded")
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("detached")
    const linksAfter = await host.storage.objects.listLinks({
      projectId: host.id,
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

    const { host, sixb } = createSixb([captureSensorName], [Device, Sensor])
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
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "captureSensorName",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("succeeded")
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("Sensor 1")
  })

  test("reads typed telemetry histories in one action batch", async () => {
    const generateReport = defineAction("generateReport")
      .on(Device)
      .params({})
      .writeback(async ({ read, run, target }) => {
        const histories = await read.telemetry.historyBatch({
          series: [
            { objectId: "device-2", property: Device.p.temperature },
            { objectId: target.primaryId, property: Device.p.temperature },
            { objectId: "device-2", property: Device.p.temperature },
          ],
          from: new Date("2026-04-01T00:00:00.000Z"),
          to: run.startedAt,
          limitPerSeries: 2,
          order: "desc",
        })

        return {
          series: histories.map((history) => ({
            objectId: history.objectId,
            propertyId: history.property.id,
            values: history.points.map((point) => point.value),
            units: history.points.map((point) => point.unit ?? null),
          })),
        }
      })

    const { host, sixb } = createSixb([generateReport])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await sixb.objects.upsert("Device", { id: "device-2", name: "Device 2" })
    await sixb.objects.appendTelemetry("Device", [
      {
        id: "device-1",
        properties: { temperature: { value: 18, unit: "degreeCelsius" } },
        at: new Date("2026-04-02T08:00:00.000Z"),
      },
      {
        id: "device-1",
        properties: { temperature: { value: 19, unit: "degreeCelsius" } },
        at: new Date("2026-04-03T08:00:00.000Z"),
      },
      {
        id: "device-2",
        properties: { temperature: { value: 20, unit: "degreeCelsius" } },
        at: new Date("2026-04-02T08:00:00.000Z"),
      },
      {
        id: "device-2",
        properties: { temperature: { value: 21, unit: "degreeCelsius" } },
        at: new Date("2026-04-03T08:00:00.000Z"),
      },
      {
        id: "device-2",
        properties: { temperature: { value: 22, unit: "degreeCelsius" } },
        at: new Date("2026-04-04T08:00:00.000Z"),
      },
      {
        id: "device-2",
        properties: { temperature: { value: 99, unit: "degreeCelsius" } },
        at: new Date("2099-05-01T08:00:00.000Z"),
      },
    ])
    await prepareActionRun(host, {
      id: "act_report",
      actionId: "generateReport",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_report",
    })

    expect(result.status).toBe("succeeded")
    expect(result.writeback?.result).toEqual({
      series: [
        {
          objectId: "device-2",
          propertyId: "temperature",
          values: [22, 21],
          units: ["degreeCelsius", "degreeCelsius"],
        },
        {
          objectId: "device-1",
          propertyId: "temperature",
          values: [19, 18],
          units: ["degreeCelsius", "degreeCelsius"],
        },
        {
          objectId: "device-2",
          propertyId: "temperature",
          values: [22, 21],
          units: ["degreeCelsius", "degreeCelsius"],
        },
      ],
    })
  })

  // A writeback that read state and then called an external system cannot run again. When that
  // state changed before the commit, only edits and commit replay, with the same writeback value
  // and a fresh read of current state. Guard proof: in `commitOnce` (`actions/run/phases.ts`),
  // compute `replayingEdits` as `false` and validation runs again; create its `ActionReadRecorder`
  // once for every attempt and the replay conflicts on the same stale read until the run fails.
  test("replays only edits and commit when a writeback read changed before the commit", async () => {
    let validations = 0
    let writebacks = 0
    let edits = 0
    let duringExternalCall: (() => Promise<void>) | null = null
    const captureSensorName = defineAction("captureSensorName")
      .on(Device)
      .params({})
      .validate(() => {
        validations += 1
      })
      .writeback(async ({ read, target }) => {
        writebacks += 1
        const links = await read.objects(Device).byId(target.primaryId).listLinks(Device.l.sensor)
        const sensor = await read.objects(Sensor).byId(links[0].targetId).get()
        await duringExternalCall?.()
        return { sensorName: String(sensor?.properties.name ?? "unknown") }
      })
      .edits(({ objects, subject, writeback }) => {
        edits += 1
        objects(Device).byId(subject.primaryId).update({ status: writeback.sensorName })
      })

    const { host, sixb } = createSixb([captureSensorName], [Device, Sensor])
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

    await prepareActionRun(host, {
      id: "act_1",
      actionId: "captureSensorName",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({ host, runId: "act_1" })

    expect(result.status).toBe("succeeded")
    expect(validations).toBe(1)
    expect(writebacks).toBe(1)
    expect(edits).toBe(2)
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("Sensor 1")
  })

  // Returning `objectSet.query()` unwrapped from the core read facade commits the stale name in a
  // single attempt. Guard proof for the restart: rethrow every conflict from `commitWithReplay`
  // (`actions/run/phases.ts`) and the run fails with `action.read_conflict`.
  test("restarts from validation when a read conflict comes before the boundary", async () => {
    let validations = 0
    let edits = 0
    let beforeCommit: (() => Promise<void>) | null = null
    const summarize = defineAction("summarize")
      .params({})
      .validate(() => {
        validations += 1
      })
      .edits(async ({ objects, read }) => {
        edits += 1
        const { objects: devices } = await read.objects(Device).query().list()
        await beforeCommit?.()
        objects(Sensor).create({
          id: "summary",
          name: devices.map((device) => device.properties.name).join(", "),
        })
      })

    const { host, sixb } = createSixb([summarize], [Device, Sensor])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    beforeCommit = async () => {
      beforeCommit = null
      await sixb.objects.upsert("Device", { id: "device-1", name: "Renamed mid-run" })
    }

    await prepareActionRun(host, {
      id: "act_1",
      actionId: "summarize",
      subject: { kind: "none" },
      params: {},
    })
    const result = await executePreparedRun({ host, runId: "act_1" })

    expect(result.status).toBe("succeeded")
    expect(validations).toBe(2)
    expect(edits).toBe(2)
    expect((await sixb.objects(Sensor).get("summary"))?.properties.name).toBe("Renamed mid-run")
  })

  // Guard proof: raise `MAX_COMMIT_ATTEMPTS` in `actions/run/phases.ts` and the edits count follows.
  test("fails with action.read_conflict after three conflicting commits", async () => {
    let edits = 0
    const contested = defineAction("contested")
      .params({})
      .edits(async ({ objects, read }) => {
        edits += 1
        await read.objects(Device).byId("device-1").get()
        await sixb.objects.upsert("Device", { id: "device-1", name: `Renamed ${edits}` })
        objects(Sensor).create({ id: "summary", name: "never committed" })
      })

    const { host, sixb } = createSixb([contested], [Device, Sensor])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "contested",
      subject: { kind: "none" },
      params: {},
    })
    const result = await executePreparedRun({ host, runId: "act_1" })

    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.error).toMatchObject({
        code: "action.read_conflict",
        message: "Data the Action read changed before its commit.",
        retryable: true,
        details: { actionId: "contested", runId: "act_1", phase: "commit" },
      })
    }
    expect(edits).toBe(3)
    expect(await sixb.objects(Sensor).get("summary")).toBeNull()
  })

  // The commit is never interrupted, so a deadline that passes during it lets it end; the conflict
  // it then reports stands. Guard proof: drop the deadline check from `commitWithReplay`
  // (`actions/run/phases.ts`), and the restart stops at the deadline as `action.timeout` instead.
  test("does not restart a conflicting commit once the deadline has passed", async () => {
    let edits = 0
    let deadline: AbortSignal | undefined
    const contested = defineAction("contested")
      .params({})
      .edits(async ({ objects, read, signal }) => {
        edits += 1
        deadline = signal
        await read.objects(Device).byId("device-1").get()
        await sixb.objects.upsert("Device", { id: "device-1", name: `Renamed ${edits}` })
        objects(Sensor).create({ id: "summary", name: "never committed" })
      })

    const { host, sixb } = createSixb([contested], [Device, Sensor])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "contested",
      subject: { kind: "none" },
      params: {},
    })
    // The commit records the run first: hold it there until the deadline passed.
    const restore = decorateOperationScopedMethodForTesting(
      host.storage.actionRuns!,
      "record",
      (record) => async (input) => {
        if (deadline) await aborted(deadline)
        return record(input)
      }
    )

    try {
      const result = await executePreparedRun({ host, runId: "act_1", timeoutMs: DEADLINE_MS })

      expect(result.status).toBe("failed")
      if (result.status === "failed") expect(result.error.code).toBe("action.read_conflict")
      expect(edits).toBe(1)
    } finally {
      restore()
    }
  })

  test("records a failed run when the action definition is missing", async () => {
    const { host } = createSixb([])
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "missingAction",
      subject: { kind: "none" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.error).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        retryable: false,
        details: { actionId: "missingAction", runId: "act_1", phase: "validation" },
      })
    }
    const run = await host.storage.actionRuns!.getById({ projectId: host.id, id: "act_1" })
    expect(run?.status).toBe("failed")
    expect(run?.phase).toBe("validation")
  })

  test("records effects errors without failing committed actions", async () => {
    const originalError = new Error("notification failed")
    const setStatus = defineAction("setStatus")
      .on(Device)
      .params({})
      .edits(({ objects, subject }) => {
        objects(Device).byId(subject.primaryId).update({ status: "ready" })
      })
      .effects(() => {
        throw originalError
      })

    const { host, sixb } = createSixb([setStatus])
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const reporter = attachSixbErrorReporter(host, (error, context) => {
      reports.push({ error, context })
    })
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("succeeded")
    const run = await host.storage.actionRuns!.getById({ projectId: host.id, id: "act_1" })
    expect(run?.status).toBe("succeeded")
    expect(run?.effects).toMatchObject({
      status: "failed",
      error: {
        code: "action.phase_failed",
        message: "Action execution failed.",
        retryable: false,
        details: { actionId: "setStatus", runId: "act_1", phase: "effects" },
      },
    })
    await reporter.flush()
    expect(reports).toHaveLength(1)
    expect(reports[0]?.error).toBe(originalError)
    expect(reports[0]?.context).toMatchObject({
      type: "action.phase.failed",
      projectId: host.id,
      actionId: "setStatus",
      runId: "act_1",
      phase: "effects",
      failure: run?.effects?.error,
    })
    expect(reports[0]?.context.occurredAt).toBe(run?.effects?.error?.at ?? "")
  })

  test("records a run its caller cancelled as failed, without reporting it", async () => {
    let enteredWriteback: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      enteredWriteback = resolve
    })
    const waitForCancel = defineAction("waitForCancel")
      .params({})
      .writeback(
        ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            enteredWriteback?.()
            signal.addEventListener(
              "abort",
              () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
              { once: true }
            )
          })
      )
    const { host, sixb } = createSixb([waitForCancel])
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })
    await prepareActionRun(host, {
      id: "act_cancelled",
      actionId: "waitForCancel",
      subject: { kind: "none" },
      params: {},
    })
    const controller = new AbortController()

    const execution = executePreparedRun({
      host,
      runId: "act_cancelled",
      signal: controller.signal,
    })
    await entered
    controller.abort(new Error("caller went away"))
    const result = await execution

    expect(result).toMatchObject({
      status: "failed",
      phase: "writeback",
      error: {
        code: "runtime.cancelled",
        message: "Execution was cancelled.",
        retryable: false,
        details: { actionId: "waitForCancel", runId: "act_cancelled", phase: "writeback" },
      },
    })
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

    const { host, sixb } = createSixb([setStatus], [Device, Sensor])
    await sixb.objects.upsert("Sensor", {
      id: "sensor-1",
      name: "Sensor 1",
    })
    await prepareActionRun(host, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Sensor", primaryId: "sensor-1" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.error).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        retryable: false,
        details: { actionId: "setStatus", runId: "act_1", phase: "validation" },
      })
    }
    expect(invoked).toBe(0)
  })

  test("reports a failed run once, with the handler's original error", async () => {
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
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await prepareActionRun(host, {
      id: "act_fail",
      actionId: "fail",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({ host, runId: "act_fail" })
    await reporter.flush()

    if (result.status !== "failed") throw new Error(`Expected a failed run, got ${result.status}.`)
    expect(result.error).toMatchObject({
      code: "action.phase_failed",
      details: { actionId: "fail", runId: "act_fail", phase: "writeback" },
    })
    expect(result.error).toEqual(result.error)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.error).toBe(originalError)
    expect(reports[0]?.context).toEqual({
      type: "run.failed",
      notificationId: `project:${host.id}:run:action:act_fail:failed:${result.error.at}`,
      projectId: host.id,
      occurredAt: result.error.at,
      runKind: "action",
      run: { runId: "act_fail", actionId: "fail" },
      failure: result.error,
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
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await prepareActionRun(host, {
      id: "act_log",
      actionId: "noteStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: { status: "active" },
    })

    await executePreparedRun({ host, runId: "act_log" })

    const { records } = await host.broker.read({
      projectId: host.id,
      streamId: LOGS_STREAM.id,
      names: ["action.info"],
    })
    const line = records.find(
      (record) => (record.payload as { message?: string }).message === "Applying status"
    )
    expect(line?.key).toBe("action:act_log")
    expect(line?.payload).toMatchObject({
      level: "info",
      fields: { status: "active" },
      context: { phase: "writeback", run: { kind: "action", id: "act_log" } },
    })
  })

  test("hands stored date and timestamp params to handlers as Dates", async () => {
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
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    // Stored params are JSON, as a request normalized them.
    await prepareActionRun(host, {
      id: "act_due",
      actionId: "setDue",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: { dueDate: "2026-06-20T12:34:56.000Z", day: "2026-06-20" },
    })

    const result = await executePreparedRun({ host, runId: "act_due" })

    expect(result.status).toBe("succeeded")
    const seen = observed[0]
    expect(seen?.dueDate).toBeInstanceOf(Date)
    expect(seen?.day).toBeInstanceOf(Date)
    expect((seen?.dueDate as Date).toISOString()).toBe("2026-06-20T12:34:56.000Z")
  })
})

describe("runAction model accounting", () => {
  test("persists a decision writeback and accounts for it under the run's attempt", async () => {
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
    const decideStatus = defineAction("decide-status")
      .on(Device)
      .params({})
      .writeback(
        async ({ sixb }) =>
          (await sixb.models.decision.evaluate({ model, input: "Repaired", questions })).output
      )
      .edits(({ objects, subject, writeback }) => {
        objects(Device).byId(subject.primaryId).update({ status: writeback.status.choice })
      })
    const { host, sixb } = createSixb([decideStatus])
    await sixb.objects.upsert("Device", { id: "decision-device", name: "Device" })
    await prepareActionRun(host, {
      id: "act_decide",
      actionId: decideStatus.id,
      subject: { kind: "object", objectTypeId: "Device", primaryId: "decision-device" },
      params: {},
    })

    const run = await executePreparedRun({ host, runId: "act_decide" })

    expect(run.status).toBe("succeeded")
    expect(run.writeback).toMatchObject({
      status: "succeeded",
      result: { status: { choice: "ready" } },
    })
    expect(
      await host.storage.aiUsage?.getLatestForExecution({
        projectId: host.id,
        executionId: run.executionId,
      })
    ).toMatchObject({ attempt: 1, usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } })
  })

  test("accounts for direct generation in writeback before persisting the result", async () => {
    // Removal proof: remove models from the Action facade or the run's attempt binding.
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
    const extractStatus = defineAction("extract-status")
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
    const { host, sixb } = createSixb([extractStatus])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device" })
    await prepareActionRun(host, {
      id: "act_extract",
      actionId: extractStatus.id,
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const run = await executePreparedRun({ host, runId: "act_extract" })

    expect(run.status).toBe("succeeded")
    expect(run.writeback).toMatchObject({ status: "succeeded", result: { status: "ready" } })
    expect(
      await host.storage.aiUsage?.getLatestForExecution({
        projectId: host.id,
        executionId: run.executionId,
      })
    ).toMatchObject({ attempt: 1, requesterGroupIds: [], usage: { totalTokens: 8 } })
  })
})

describe("runAction deadline and boundary", () => {
  // Guard proof: return the handler's error unchanged from `translateActionPhaseError`
  // (`actions/run/normalize.ts`) when its signal aborted, and the run fails `internal.unexpected`.
  test("fails with action.timeout when the deadline passes before the boundary", async () => {
    let edits = 0
    const slowWriteback = defineAction("slowWriteback")
      .on(Device)
      .params({})
      .writeback(async ({ signal }) => {
        await aborted(signal)
        // What an aborted `fetch` throws: the handler's own error, not the deadline's reason.
        throw new DOMException("The operation was aborted.", "AbortError")
      })
      .edits(({ objects, subject }) => {
        edits += 1
        objects(Device).byId(subject.primaryId).update({ status: "never committed" })
      })
    const { host, sixb } = createSixb([slowWriteback])
    const reports: SixbErrorContext[] = []
    const reporter = attachSixbErrorReporter(host, (_error, context) => {
      reports.push(context)
    })
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1", status: "old" })
    await prepareActionRun(host, {
      id: "act_slow",
      actionId: "slowWriteback",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({ host, runId: "act_slow", timeoutMs: DEADLINE_MS })

    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.error).toMatchObject({
        code: "action.timeout",
        message: "The Action exceeded its 30-second time limit.",
        retryable: false,
        details: { actionId: "slowWriteback", runId: "act_slow", phase: "writeback" },
      })
    }
    expect(result.writeback).toMatchObject({
      status: "failed",
      error: { code: "action.timeout" },
    })
    expect(edits).toBe(0)
    expect((await deviceObjects(sixb).get("device-1"))?.properties.status).toBe("old")
    await reporter.flush()
    expect(reports).toMatchObject([{ type: "run.failed", failure: { code: "action.timeout" } }])
  })

  // Guard proof: in `commitOnce` (`actions/run/phases.ts`), run edits under `signal` even after a
  // succeeded writeback, and the run fails with `action.timeout` after its external change.
  test("commits after a succeeded writeback even when the deadline passes during edits", async () => {
    let deadline: AbortSignal | undefined
    let editsSignalAborted: boolean | undefined
    const lateEdits = defineAction("lateEdits")
      .on(Device)
      .params({})
      .writeback(({ signal }) => {
        deadline = signal
        return { status: "written" }
      })
      .edits(async ({ objects, subject, writeback, signal }) => {
        if (deadline) await aborted(deadline)
        editsSignalAborted = signal.aborted
        objects(Device).byId(subject.primaryId).update({ status: writeback.status })
      })
    const { host, sixb } = createSixb([lateEdits])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await prepareActionRun(host, {
      id: "act_late",
      actionId: "lateEdits",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({ host, runId: "act_late", timeoutMs: DEADLINE_MS })

    expect(result.status).toBe("succeeded")
    expect(deadline?.aborted).toBe(true)
    expect(editsSignalAborted).toBe(false)
    expect((await deviceObjects(sixb).get("device-1"))?.properties.status).toBe("written")
  })

  // Guard proof: drop `throwIfAborted(input.signal)` before the commit in `runEditsAndCommitPhase`
  // (`actions/run/edits-commit.ts`), and the edits recorded after the deadline commit.
  test("commits nothing when the deadline passes during edits of an Action without writeback", async () => {
    const slowEdits = defineAction("slowEdits")
      .on(Device)
      .params({})
      .edits(async ({ objects, subject, signal }) => {
        objects(Device).byId(subject.primaryId).update({ status: "too late" })
        // A handler that ignores its signal and returns once the deadline passed.
        await aborted(signal)
      })
    const { host, sixb } = createSixb([slowEdits])
    attachSixbErrorReporter(host, () => {})
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1", status: "old" })
    await prepareActionRun(host, {
      id: "act_slow_edits",
      actionId: "slowEdits",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_slow_edits",
      timeoutMs: DEADLINE_MS,
    })

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "action.timeout", details: { runId: "act_slow_edits", phase: "edits" } },
    })
    expect(await findEditCommit(host, "act_slow_edits")).toBeNull()
    expect((await deviceObjects(sixb).get("device-1"))?.properties.status).toBe("old")
  })

  // Guard proof: share one signal between runs in `ActionRunSignals` (`actions/run/signals.ts`),
  // and every run hands its edits the same signal, whose listeners then live as long as the
  // process.
  test("gives each run its own signal past the boundary", async () => {
    const editsSignals: AbortSignal[] = []
    const written = defineAction("written")
      .on(Device)
      .params({})
      .writeback(() => ({ status: "written" }))
      .edits(({ objects, subject, writeback, signal }) => {
        editsSignals.push(signal)
        objects(Device).byId(subject.primaryId).update({ status: writeback.status })
      })
    const { host, sixb } = createSixb([written])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    for (const id of ["act_first", "act_second"]) {
      await prepareActionRun(host, {
        id,
        actionId: "written",
        subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
        params: {},
      })
      expect((await executePreparedRun({ host, runId: id })).status).toBe("succeeded")
    }

    expect(editsSignals).toHaveLength(2)
    expect(editsSignals[0]).not.toBe(editsSignals[1])
    expect(editsSignals.map((signal) => signal.aborted)).toEqual([false, false])
  })

  // Guard proof: in `commitOnce` (`actions/run/phases.ts`), check `signal` instead of `editsSignal`
  // right after the writeback, and this run fails although its external change happened.
  test("commits a writeback that succeeds after the deadline passed", async () => {
    const lateWriteback = defineAction("lateWriteback")
      .on(Device)
      .params({})
      .writeback(async ({ signal }) => {
        await aborted(signal)
        return { status: "written late" }
      })
      .edits(({ objects, subject, writeback }) => {
        objects(Device).byId(subject.primaryId).update({ status: writeback.status })
      })
    const { host, sixb } = createSixb([lateWriteback])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await prepareActionRun(host, {
      id: "act_late",
      actionId: "lateWriteback",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({ host, runId: "act_late", timeoutMs: DEADLINE_MS })

    expect(result.status).toBe("succeeded")
    expect((await deviceObjects(sixb).get("device-1"))?.properties.status).toBe("written late")
  })

  // Guard proof: in `commitOnce` (`actions/run/phases.ts`), run edits under `signal` even after a
  // succeeded writeback, and the caller's abort fails the run after its external change.
  test("ignores its caller's abort once past the boundary", async () => {
    const controller = new AbortController()
    const abortedByCaller = defineAction("abortedByCaller")
      .on(Device)
      .params({})
      .writeback(() => ({ status: "written" }))
      .edits(({ objects, subject, writeback }) => {
        controller.abort(new Error("caller went away"))
        objects(Device).byId(subject.primaryId).update({ status: writeback.status })
      })
    const { host, sixb } = createSixb([abortedByCaller])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await prepareActionRun(host, {
      id: "act_abandoned",
      actionId: "abortedByCaller",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({
      host,
      runId: "act_abandoned",
      signal: controller.signal,
    })

    expect(result.status).toBe("succeeded")
    expect((await deviceObjects(sixb).get("device-1"))?.properties.status).toBe("written")
  })

  // Guard proof: run effects under `signals.uninterruptible` in `runActionEffects`
  // (`actions/run/effects.ts`) and this effects handler never returns.
  test("records effects that outlast their own deadline without failing the run", async () => {
    const slowEffects = defineAction("slowEffects")
      .on(Device)
      .params({})
      .edits(({ objects, subject }) => {
        objects(Device).byId(subject.primaryId).update({ status: "ready" })
      })
      .effects(async ({ signal }) => {
        await aborted(signal)
        signal.throwIfAborted()
      })
    const { host, sixb } = createSixb([slowEffects])
    attachSixbErrorReporter(host, () => {})
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    await prepareActionRun(host, {
      id: "act_effects",
      actionId: "slowEffects",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await executePreparedRun({ host, runId: "act_effects", timeoutMs: DEADLINE_MS })

    expect(result.status).toBe("succeeded")
    expect(result.effects).toMatchObject({
      status: "failed",
      error: { code: "action.timeout", details: { phase: "effects" } },
    })
    expect((await deviceObjects(sixb).get("device-1"))?.properties.status).toBe("ready")
  })
})
