import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "../src"
import { ProjectionRunDispatcher } from "../src/projections/run-dispatch"

const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
})

const devices = defineDataset("raw.devices", {
  schema: [col("device_id", "string"), col("device_name", "string")],
})

const deviceProjection = defineProjection("project-devices", Device)
  .fromDataset(devices)
  .properties({ id: "device_id" })

function createDependencies(projection = deviceProjection) {
  const storage = new InMemoryStorage()
  const lakeStorage = new InMemoryLakeStorage()
  const queues = new InMemoryQueues()
  const host = new SixbHost({
    id: "projection-dispatch-tests",
    ontology: [Device],
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    storage,
    lakeStorage,
    queues,
    datasets: [devices],
    projections: [projection],
  })
  return { host, lakeStorage, queues, storage }
}

async function commitDevicesVersion(
  lakeStorage: InMemoryLakeStorage,
  producer: { readonly kind: "sync"; readonly id: string; readonly runId: string } = {
    kind: "sync",
    id: "sync-devices",
    runId: "sync-run",
  }
) {
  await lakeStorage.createDataset(devices)
  const write = await lakeStorage.beginWrite({ dataset: devices, mode: "snapshot", producer })
  await write.writeRows([{ device_id: "device-1", device_name: "Kitchen sensor" }])
  return write.commit()
}

function dispatchInput(version: Awaited<ReturnType<typeof commitDevicesVersion>>) {
  return {
    projectionId: deviceProjection.id,
    datasetVersion: {
      datasetId: version.datasetId,
      versionId: version.versionId,
      createdAt: version.createdAt.toISOString(),
    },
  }
}

describe("ProjectionRunDispatcher", () => {
  test("persists the execution and queued run before publishing their run identity", async () => {
    const { host, lakeStorage, queues, storage } = createDependencies()
    await storage.auth.users.create({
      id: "requester",
      projectId: host.id,
      email: "requester@example.com",
    })
    await storage.executions.create({
      id: "sync-execution",
      projectId: host.id,
      requestedBy: { type: "user", id: "requester" },
      executor: { type: "primitive", kind: "sync", runId: "sync-run" },
      source: { type: "schedule", eventId: "sync-schedule-event" },
      correlationId: "source-correlation",
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "sync", id: "sync-devices", runId: "sync-run" },
      },
    })
    await storage.syncRuns!.queue({
      id: "sync-run",
      projectId: host.id,
      executionId: "sync-execution",
      syncId: "sync-devices",
      datasetId: devices.id,
      mode: "snapshot",
    })
    const version = await commitDevicesVersion(lakeStorage)
    let observedAdmission = false
    const enqueue = queues.projections.enqueue.bind(queues.projections)
    queues.projections.enqueue = async (input) => {
      const runId = input.jobs[0]?.payload.runId
      const run = runId
        ? await storage.projectionRuns.getById({ projectId: host.id, id: runId })
        : null
      const execution = run
        ? await storage.executions.getById({ projectId: host.id, id: run.executionId })
        : null
      observedAdmission = run?.status === "queued" && execution !== null
      return enqueue(input)
    }

    const result = await new ProjectionRunDispatcher(host).dispatch(dispatchInput(version))
    const run = await storage.projectionRuns.getById({ projectId: host.id, id: result.runId })
    const execution = run
      ? await storage.executions.getById({ projectId: host.id, id: run.executionId })
      : null

    expect(observedAdmission).toBe(true)
    expect(result).toMatchObject({ jobId: result.runId, created: true })
    expect(run).toMatchObject({ status: "queued", attempt: 0, executionId: execution?.id })
    expect(execution).toMatchObject({
      requestedBy: { type: "user", id: "requester" },
      executor: { type: "primitive", kind: "projection", runId: result.runId },
      source: {
        type: "datasetVersion",
        datasetId: devices.id,
        versionId: version.versionId,
      },
      correlationId: "source-correlation",
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "projection", id: deviceProjection.id, runId: result.runId },
      },
    })
    const [claimed] = await queues.projections.claim({ projectId: host.id, workerId: "test" })
    expect(claimed?.job.payload).toEqual({ runId: result.runId })
  })

  test("reuses one execution when queue publication is retried", async () => {
    const { host, lakeStorage, queues, storage } = createDependencies()
    const version = await commitDevicesVersion(lakeStorage)
    const enqueue = queues.projections.enqueue.bind(queues.projections)
    let attempts = 0
    queues.projections.enqueue = async (input) => {
      attempts += 1
      if (attempts === 1) throw new Error("queue unavailable")
      return enqueue(input)
    }
    const dispatcher = new ProjectionRunDispatcher(host)

    await expect(dispatcher.dispatch(dispatchInput(version))).rejects.toThrow("queue unavailable")
    const failed = (await storage.projectionRuns.list({ projectId: host.id })).runs[0]
    expect(failed).toMatchObject({
      status: "failed",
      attempt: 0,
      error: { phase: "enqueue", message: "queue unavailable" },
    })

    const retried = await dispatcher.dispatch(dispatchInput(version))
    const replayed = await dispatcher.dispatch(dispatchInput(version))
    const run = await storage.projectionRuns.getById({ projectId: host.id, id: retried.runId })
    expect(retried).toMatchObject({ created: false, jobId: retried.runId })
    expect(replayed).toMatchObject({ created: false })
    expect(replayed.jobId).toBeUndefined()
    expect(run).toMatchObject({ executionId: failed?.executionId, status: "queued", attempt: 0 })
    expect(attempts).toBe(2)
  })

  test("creates a distinct run when the registered Projection semantics change", async () => {
    const dependencies = createDependencies()
    const version = await commitDevicesVersion(dependencies.lakeStorage)
    const first = await new ProjectionRunDispatcher(dependencies.host).dispatch(
      dispatchInput(version)
    )
    const revisedProjection = defineProjection("project-devices", Device)
      .fromDataset(devices)
      .properties({ id: "device_id", name: "device_name" })
    const revisedHost = new SixbHost({
      id: dependencies.host.id,
      ontology: [Device],
      broker: dependencies.host.broker,
      blobStorage: dependencies.host.blobStorage,
      storage: dependencies.storage,
      lakeStorage: dependencies.lakeStorage,
      queues: dependencies.queues,
      datasets: [devices],
      projections: [revisedProjection],
    })

    const revised = await new ProjectionRunDispatcher(revisedHost).dispatch({
      ...dispatchInput(version),
      projectionId: revisedProjection.id,
    })

    expect(revised.runId).not.toBe(first.runId)
    expect(revised.created).toBe(true)
    expect(
      (await dependencies.storage.projectionRuns.list({ projectId: revisedHost.id })).runs
    ).toHaveLength(2)
  })

  test("rejects producer metadata that points at a different durable Sync", async () => {
    const { host, lakeStorage, storage } = createDependencies()
    await storage.executions.create({
      id: "sync-execution",
      projectId: host.id,
      executor: { type: "primitive", kind: "sync", runId: "sync-run" },
      source: { type: "event", eventId: "sync-event" },
      correlationId: "sync-correlation",
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "sync", id: "sync-devices", runId: "sync-run" },
      },
    })
    await storage.syncRuns!.queue({
      id: "sync-run",
      projectId: host.id,
      executionId: "sync-execution",
      syncId: "sync-devices",
      datasetId: devices.id,
      mode: "snapshot",
    })
    const version = await commitDevicesVersion(lakeStorage, {
      kind: "sync",
      id: "different-sync",
      runId: "sync-run",
    })

    await expect(
      new ProjectionRunDispatcher(host).dispatch(dispatchInput(version))
    ).rejects.toThrow("does not match run 'sync-run'")
    expect((await storage.projectionRuns.list({ projectId: host.id })).runs).toEqual([])
  })
})
