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
import { findActionEditCommit } from "../src/actions"
import { type ActionRunHost, executeActionRun } from "../src/actions/run/execute"
import { runAction } from "../src/actions/run/run-action"
import { ActionRunSignals } from "../src/actions/run/signals"
import type { ActionRunContext } from "../src/actions/run/types"
import { attachSixbErrorReporter } from "../src/error-reporting/internal"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import type { ActionRunParams, ActionRunRecord } from "../src/storage"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { createTestSixb, queueTestActionRun } from "../src/testing"

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
    id: "action-worker-tests",
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

async function createContext(host: ActionRunHost, run: ActionRunRecord): Promise<ActionRunContext> {
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

async function queueActionRun(
  host: ActionRunHost,
  input: {
    readonly id: string
    readonly actionId: string
    readonly subject: ActionSubject
    readonly params: ActionRunParams
  }
): Promise<ActionRunRecord> {
  return queueTestActionRun(host.storage, {
    projectId: host.id,
    id: input.id,
    actionId: input.actionId,
    subject: input.subject,
    params: input.params,
    idempotencyKey: `action:${host.id}:${input.id}`,
  })
}

async function runStoredAction(input: {
  readonly host: ActionRunHost
  readonly runId: string
  readonly signal?: AbortSignal
  readonly attempt?: number
  readonly timeoutMs?: number
}) {
  const { result } = await executeActionRun(input.host, {
    runId: input.runId,
    signal: input.signal,
    attempt: input.attempt ?? 1,
    timeoutMs: input.timeoutMs,
  })
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
    await queueActionRun(host, {
      id: "invalid-edit",
      actionId: invalid.id,
      subject: { kind: "none" },
      params: {},
    })
    await runStoredAction({ host, runId: "invalid-edit" })
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
    const run = await queueActionRun(host, {
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
          attempt: 1,
        })
      ).rejects.toMatchObject({
        code: "internal.unexpected",
        message:
          "[Sixb] Action run 'act_stored' belongs to project 'other-project', not 'action-worker-tests'.",
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
    await queueActionRun(host, {
      id: "act_nullable",
      actionId: "captureNullable",
      subject: { kind: "none" },
      params: { reviewedAt: null },
    })

    const result = await runStoredAction({
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
    await queueActionRun(host, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: { status: "ready" },
    })

    const result = await runStoredAction({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("succeeded")
    const run = await host.storage.actionRuns!.getById({ projectId: host.id, id: "act_1" })
    expect(run?.status).toBe("succeeded")
    expect(run?.phase).toBe("commit")
    const commit = await findActionEditCommit({
      storage: host.storage,
      projectId: host.id,
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

    const { host, sixb } = createSixb([failWriteback])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
      status: "old",
    })
    await queueActionRun(host, {
      id: "act_1",
      actionId: "failWriteback",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
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
    expect(
      await findActionEditCommit({ storage: host.storage, projectId: host.id, runId: "act_1" })
    ).toBeNull()
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBe("old")
  })

  test("keeps run finalization failures out of the phase-failed vocabulary", async () => {
    const complete = defineAction("complete")
      .params({})
      .writeback(() => ({ ok: true }))
    const { host } = createSixb([complete])
    await queueActionRun(host, {
      id: "act_finalize",
      actionId: "complete",
      subject: { kind: "none" },
      params: {},
    })

    const actionRuns = host.storage.actionRuns!
    const finish = actionRuns.finish.bind(actionRuns)
    actionRuns.finish = async (input) => {
      if (input.status === "succeeded") {
        throw new Error("finish exploded")
      }
      return finish(input)
    }

    const result = await runStoredAction({
      host,
      runId: "act_finalize",
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: { actionId: "complete", runId: "act_finalize", phase: "writeback" },
      })
    }
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
    await queueActionRun(host, {
      id: "act_blob",
      actionId: "persistPayload",
      subject: { kind: "none" },
      params: {},
    })

    const result = await runStoredAction({
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

  test("skips duplicate terminal run ids without invoking phases twice", async () => {
    let invoked = 0
    const count = defineAction("count")
      .on(Device)
      .params({})
      .writeback(() => {
        invoked += 1
      })

    const { host, sixb } = createSixb([count])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await queueActionRun(host, {
      id: "act_1",
      actionId: "count",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    await runStoredAction({
      host,
      runId: "act_1",
    })

    const duplicate = await runStoredAction({
      host,
      runId: "act_1",
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

    const { host, sixb } = createSixb([createDevice])
    await queueActionRun(host, {
      id: "act_1",
      actionId: "createDevice",
      subject: { kind: "none" },
      params: { id: "device-1" },
    })
    const result = await runStoredAction({
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

    await queueActionRun(host, {
      id: "act_create",
      actionId: "createDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Device 1" },
    })
    const created = await runStoredAction({
      host,
      runId: "act_create",
    })

    await queueActionRun(host, {
      id: "act_rename",
      actionId: "renameDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Renamed Device" },
    })
    const updated = await runStoredAction({
      host,
      runId: "act_rename",
    })

    expect(created.status).toBe("succeeded")
    expect(updated.status).toBe("succeeded")
    const commits = await Promise.all(
      ["act_create", "act_rename"].map((runId) =>
        findActionEditCommit({ storage: host.storage, projectId: host.id, runId })
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

    await queueActionRun(host, {
      id: "act_assign_sensor",
      actionId: "assignSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: { sensorId: "sensor-2" },
    })
    expect(
      (
        await runStoredAction({
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

    await queueActionRun(host, {
      id: "act_clear_sensor",
      actionId: "clearSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })
    expect(
      (
        await runStoredAction({
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
    await queueActionRun(host, {
      id: "act_1",
      actionId: "detachSensor",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({
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
    await queueActionRun(host, {
      id: "act_1",
      actionId: "captureSensorName",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({
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
    await queueActionRun(host, {
      id: "act_report",
      actionId: "generateReport",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({
      host,
      runId: "act_report",
    })

    expect(result.status).toBe("succeeded")
    expect(result.record.writeback?.result).toEqual({
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

    await queueActionRun(host, {
      id: "act_1",
      actionId: "captureSensorName",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({ host, runId: "act_1" })

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

    await queueActionRun(host, {
      id: "act_1",
      actionId: "summarize",
      subject: { kind: "none" },
      params: {},
    })
    const result = await runStoredAction({ host, runId: "act_1" })

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
    await queueActionRun(host, {
      id: "act_1",
      actionId: "contested",
      subject: { kind: "none" },
      params: {},
    })
    const result = await runStoredAction({ host, runId: "act_1" })

    expect(result.status).toBe("failed")
    if ("error" in result) {
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
    await queueActionRun(host, {
      id: "act_1",
      actionId: "contested",
      subject: { kind: "none" },
      params: {},
    })
    const restore = decorateOperationScopedMethodForTesting(
      host.storage.actionRuns!,
      "enterPhase",
      (enterPhase) => async (input) => {
        if (input.phase === "commit" && deadline) await aborted(deadline)
        return enterPhase(input)
      }
    )

    try {
      const result = await runStoredAction({ host, runId: "act_1", timeoutMs: DEADLINE_MS })

      expect(result.status).toBe("failed")
      if ("error" in result) expect(result.error.code).toBe("action.read_conflict")
      expect(edits).toBe(1)
    } finally {
      restore()
    }
  })

  test("marks queued runs failed when the action definition is missing", async () => {
    const { host } = createSixb([])
    await queueActionRun(host, {
      id: "act_1",
      actionId: "missingAction",
      subject: { kind: "none" },
      params: {},
    })

    const result = await runStoredAction({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
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

  test("reports a lease-loss failure once and not on terminal redelivery", async () => {
    let invoked = 0
    const count = defineAction("count")
      .params({})
      .writeback(() => {
        invoked += 1
      })

    const { host } = createSixb([count])
    let reportCount = 0
    const reporter = attachSixbErrorReporter(host, () => {
      reportCount += 1
    })
    await queueActionRun(host, {
      id: "act_1",
      actionId: "count",
      subject: { kind: "none" },
      params: {},
    })
    await host.storage.actionRuns!.start({
      projectId: host.id,
      id: "act_1",
    })

    const result = await runStoredAction({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error.code).toBe("internal.unexpected")
      expect(result.error.message).toBe("An unexpected internal error occurred.")
      expect(result.error.details.phase).toBe("validation")
    }
    expect(invoked).toBe(0)

    const run = await host.storage.actionRuns!.getById({ projectId: host.id, id: "act_1" })
    expect(run?.status).toBe("failed")
    expect(run?.phase).toBe("validation")
    expect(run?.finishedAt).toBeInstanceOf(Date)

    const redelivered = await runStoredAction({
      host,
      runId: "act_1",
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

    const { host, sixb } = createSixb([setStatus])
    await sixb.objects.upsert("Device", {
      id: "device-1",
      name: "Device 1",
    })
    await queueActionRun(host, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })
    await host.storage.actionRuns!.start({ projectId: host.id, id: "act_1" })
    await host.storage.actionRuns!.recordWriteback({
      projectId: host.id,
      id: "act_1",
      status: "succeeded",
      result: { status: "persisted" },
    })

    const result = await runStoredAction({
      host,
      runId: "act_1",
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
    const { host, sixb } = createSixb([deleteDevice])
    await sixb.objects.upsert("Device", { id: "device-1", name: "Device 1" })
    const queuedRun = await queueActionRun(host, {
      id: "act_delete",
      actionId: "deleteDevice",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })
    await host.storage.actionRuns!.start({ projectId: host.id, id: "act_delete" })
    const context = await createContext(host, queuedRun)
    await context.ontologyMutations.commitEdits({
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

    const resumed = await runStoredAction({
      host,
      runId: "act_delete",
      attempt: 2,
    })

    expect(resumed.status).toBe("succeeded")
    expect(await deviceObjects(sixb).get("device-1")).toBeNull()
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
    await queueActionRun(host, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({
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

  test("does not report cancelled runs", async () => {
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
    await queueActionRun(host, {
      id: "act_cancelled",
      actionId: "waitForCancel",
      subject: { kind: "none" },
      params: {},
    })
    const controller = new AbortController()

    const execution = runStoredAction({
      host,
      runId: "act_cancelled",
      signal: controller.signal,
      attempt: 1,
    })
    await entered
    controller.abort(new Error("worker stopping"))
    const result = await execution

    expect(result.status).toBe("cancelled")
    if ("error" in result) {
      expect(result.error).toMatchObject({
        code: "runtime.cancelled",
        message: "Execution was cancelled.",
        retryable: false,
        details: {
          actionId: "waitForCancel",
          runId: "act_cancelled",
          phase: "cancelled",
        },
      })
    }
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
    await queueActionRun(host, {
      id: "act_1",
      actionId: "setStatus",
      subject: { kind: "object", objectTypeId: "Sensor", primaryId: "sensor-1" },
      params: {},
    })

    const result = await runStoredAction({
      host,
      runId: "act_1",
    })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        retryable: false,
        details: { actionId: "setStatus", runId: "act_1", phase: "validation" },
      })
    }
    expect(invoked).toBe(0)
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
    await queueActionRun(host, {
      id: "act_slow",
      actionId: "slowWriteback",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({ host, runId: "act_slow", timeoutMs: DEADLINE_MS })

    expect(result.status).toBe("failed")
    if ("error" in result) {
      expect(result.error).toMatchObject({
        code: "action.timeout",
        message: "The Action exceeded its 30-second time limit.",
        retryable: false,
        details: { actionId: "slowWriteback", runId: "act_slow", phase: "writeback" },
      })
    }
    expect(result.record.writeback).toMatchObject({
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
    await queueActionRun(host, {
      id: "act_late",
      actionId: "lateEdits",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({ host, runId: "act_late", timeoutMs: DEADLINE_MS })

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
    await queueActionRun(host, {
      id: "act_slow_edits",
      actionId: "slowEdits",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({ host, runId: "act_slow_edits", timeoutMs: DEADLINE_MS })

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "action.timeout", details: { runId: "act_slow_edits", phase: "edits" } },
    })
    expect(
      await findActionEditCommit({
        storage: host.storage,
        projectId: host.id,
        runId: "act_slow_edits",
      })
    ).toBeNull()
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
      await queueActionRun(host, {
        id,
        actionId: "written",
        subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
        params: {},
      })
      expect((await runStoredAction({ host, runId: id })).status).toBe("succeeded")
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
    await queueActionRun(host, {
      id: "act_late",
      actionId: "lateWriteback",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({ host, runId: "act_late", timeoutMs: DEADLINE_MS })

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
    await queueActionRun(host, {
      id: "act_abandoned",
      actionId: "abortedByCaller",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({
      host,
      runId: "act_abandoned",
      signal: controller.signal,
    })

    expect(result.status).toBe("succeeded")
    expect((await deviceObjects(sixb).get("device-1"))?.properties.status).toBe("written")
  })

  // Guard proof: run effects under `signals.uninterruptible` in `executeActionPhases`
  // (`actions/run/phases.ts`) and this effects handler never returns.
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
    await queueActionRun(host, {
      id: "act_effects",
      actionId: "slowEffects",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "device-1" },
      params: {},
    })

    const result = await runStoredAction({ host, runId: "act_effects", timeoutMs: DEADLINE_MS })

    expect(result.status).toBe("succeeded")
    expect(result.record.effects).toMatchObject({
      status: "failed",
      error: { code: "action.timeout", details: { phase: "effects" } },
    })
    expect((await deviceObjects(sixb).get("device-1"))?.properties.status).toBe("ready")
  })
})
