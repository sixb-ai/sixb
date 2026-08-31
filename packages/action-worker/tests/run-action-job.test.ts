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
} from "@sixb/core"
import { findActionEditCommit } from "@sixb/core/internal/actions"
import { attachSixbErrorReporter } from "@sixb/core/internal/error-reporting"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import type { ActionRunParams, ActionRunRecord } from "@sixb/core/storage"
import { createTestSixb, queueTestActionRun } from "@sixb/core/testing"
import { runActionJob } from "../src/run-action-job"
import type { ActionWorkerContext, RunActionJobInput } from "../src/types"
import type { ActionWorkerHost } from "../src/worker"

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

function deviceObjects(sixb: ActionWorkerContext["sixb"]): DeviceObjectSet {
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

async function createContext(
  host: ActionWorkerHost,
  run: ActionRunRecord
): Promise<ActionWorkerContext> {
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
      objects: execution.sixb.objects,
      actions: execution.sixb.actions,
      connector: execution.sixb.connector,
      blobs: execution.sixb.blobs,
    },
    actions: host.definitions.actions,
  }
}

async function queueActionRun(
  host: ActionWorkerHost,
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

async function runStoredActionJob(
  input: Omit<RunActionJobInput, "run" | "runtime"> & { readonly host: ActionWorkerHost }
): ReturnType<typeof runActionJob> {
  const run = await input.host.storage.actionRuns?.getById({
    projectId: input.host.id,
    id: input.job.id,
  })
  if (!run) {
    throw new Error(`[Test] Action run '${input.job.id}' was not queued.`)
  }
  const { host, ...jobInput } = input
  return runActionJob({ ...jobInput, runtime: await createContext(host, run), run })
}

describe("runActionJob", () => {
  test("rejects a durable run that does not match the requested job", async () => {
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

    await expect(
      runActionJob({
        runtime: await createContext(host, run),
        job: {
          id: "act_other",
          actionId: "count",
        },
        run,
      })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      message:
        "[SixbActionWorker] Action job 'act_other' does not match durable run 'act_stored' in project 'action-worker-tests'.",
      retryable: false,
      details: {
        actionId: "count",
        runId: "act_other",
        durableActionId: "count",
        durableRunId: "act_stored",
        durableProjectId: "action-worker-tests",
      },
    })
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

    const result = await runStoredActionJob({
      host,
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

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "setStatus",
      },
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

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "failWriteback",
      },
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

    const result = await runStoredActionJob({
      host,
      job: { id: "act_finalize", actionId: "complete" },
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

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_blob",
        actionId: "persistPayload",
      },
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

    await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "count",
      },
    })

    const duplicate = await runStoredActionJob({
      host,
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

    const { host, sixb } = createSixb([createDevice])
    await queueActionRun(host, {
      id: "act_1",
      actionId: "createDevice",
      subject: { kind: "none" },
      params: { id: "device-1" },
    })
    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "createDevice",
      },
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
    const created = await runStoredActionJob({
      host,
      job: { id: "act_create", actionId: "createDevice" },
    })

    await queueActionRun(host, {
      id: "act_rename",
      actionId: "renameDevice",
      subject: { kind: "none" },
      params: { id: "device-1", name: "Renamed Device" },
    })
    const updated = await runStoredActionJob({
      host,
      job: { id: "act_rename", actionId: "renameDevice" },
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
        await runStoredActionJob({
          host,
          job: { id: "act_assign_sensor", actionId: "assignSensor" },
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
        await runStoredActionJob({
          host,
          job: { id: "act_clear_sensor", actionId: "clearSensor" },
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

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "detachSensor",
      },
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

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "captureSensorName",
      },
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

    const result = await runStoredActionJob({
      host,
      job: { id: "act_report", actionId: "generateReport" },
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

  test("fences a writeback read against a change made before the commit", async () => {
    // A writeback handler that reads state, calls an external system, and then commits must not
    // succeed against state that changed while the external call was in flight. The read is of a
    // non-subject object, so only the writeback recorder can catch it.
    let duringExternalCall: (() => Promise<void>) | null = null
    const captureSensorName = defineAction("captureSensorName")
      .on(Device)
      .params({})
      .writeback(async ({ read, target }) => {
        const links = await read.objects(Device).byId(target.primaryId).listLinks(Device.l.sensor)
        const sensor = await read.objects(Sensor).byId(links[0].targetId).get()
        await duringExternalCall?.()
        return { sensorName: String(sensor?.properties.name ?? "unknown") }
      })
      .edits(({ objects, subject, writeback }) => {
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

    const result = await runStoredActionJob({
      host,
      job: { id: "act_1", actionId: "captureSensorName" },
    })

    expect(result.status).toBe("failed")
    const updated = await deviceObjects(sixb).get("device-1")
    expect(updated?.properties.status).toBeUndefined()
  })

  test("marks queued runs failed when the action definition is missing", async () => {
    const { host } = createSixb([])
    await queueActionRun(host, {
      id: "act_1",
      actionId: "missingAction",
      subject: { kind: "none" },
      params: {},
    })

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "missingAction",
      },
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

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "count",
      },
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

    const redelivered = await runStoredActionJob({
      host,
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

    const result = await runStoredActionJob({
      host,
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

    const resumed = await runStoredActionJob({
      host,
      job: { id: "act_delete", actionId: "deleteDevice" },
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

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "setStatus",
      },
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
          new Promise((_resolve, reject) => {
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

    const execution = runStoredActionJob({
      host,
      job: { id: "act_cancelled", actionId: "waitForCancel" },
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

    const result = await runStoredActionJob({
      host,
      job: {
        id: "act_1",
        actionId: "setStatus",
      },
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
