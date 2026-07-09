import { describe, expect, test } from "bun:test"
import type { DatasetDefinition, DatasetRow, PipelineDefinition } from "@sixb/core"
import {
  col,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  LOGS_STREAM,
  prop,
  Sixb,
} from "@sixb/core"
import { PipelineWorker } from "../src"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const rawCustomersDataset = defineDataset("raw.customers", {
  schema: [col("id", "string"), col("name", "string")],
})

const customersDataset = defineDataset("customers", {
  schema: [col("id", "string"), col("name", "string")],
})

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn()
    if (predicate(value)) {
      return value
    }

    await Bun.sleep(20)
  }

  throw new Error("Timed out waiting for condition.")
}

function createSixbForPipeline(options: {
  readonly pipeline: PipelineDefinition
  readonly datasets: readonly DatasetDefinition[]
}) {
  return new Sixb({
    id: "pipeline-worker-tests",
    ontology: [Room],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: options.datasets,
    pipelines: [options.pipeline],
  })
}

async function seedDatasetVersion(
  lakeStorage: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[]
) {
  await lakeStorage.createDataset(dataset)
  const write = await lakeStorage.beginWrite({ dataset, mode: "snapshot" })
  await write.writeRows(rows)
  return write.commit({ commitMessage: `seed ${dataset.id}` })
}

describe("PipelineWorker", () => {
  test("requires registered pipelines and pipeline run storage", () => {
    const emptySixb = new Sixb({
      id: "pipeline-worker-tests",
      ontology: [Room],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawCustomersDataset],
    })
    expect(() => new PipelineWorker(emptySixb)).toThrow("No pipeline definitions")

    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async () => {})
    const pipeline = definePipeline("customers").then(cleanStep)
    const sixb = createSixbForPipeline({
      pipeline,
      datasets: [rawCustomersDataset, customersDataset],
    })
    const withoutPipelineRuns = {
      id: sixb.id,
      events: sixb.events,
      lakeStorage: sixb.lakeStorage,
      queues: sixb.queues,
      storage: {
        ...sixb.storage,
        pipelineRuns: undefined,
      },
      getPipelineDefinitions: () => sixb.getPipelineDefinitions(),
      getPipelineById: (pipelineId: string) => sixb.getPipelineById(pipelineId),
      getDatasetById: (datasetId: string) => sixb.getDatasetById(datasetId),
    }

    expect(() => new PipelineWorker(withoutPipelineRuns)).toThrow("storage.pipelineRuns")
  })

  test("streams a run-scoped log line to the broker", async () => {
    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output, logger }) => {
        logger.info("Cleaning customers", { phase: "clean" })
        await output.writeRows(inputs.rawCustomers.readRows())
      })
    const pipeline = definePipeline("customers").then(cleanStep)
    const sixb = createSixbForPipeline({
      pipeline,
      datasets: [rawCustomersDataset, customersDataset],
    })
    await seedDatasetVersion(sixb.lakeStorage as InMemoryLakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada" },
    ])

    const worker = new PipelineWorker(sixb)
    await sixb.queues.pipelines.enqueue({
      projectId: sixb.id,
      jobs: [
        { type: "pipeline.run.requested", payload: { pipelineId: "customers", runId: "run-log" } },
      ],
    })

    await worker.start()
    try {
      await waitFor(
        () => sixb.storage.pipelineRuns!.getById({ projectId: sixb.id, id: "run-log" }),
        (value) => value?.status === "succeeded"
      )
    } finally {
      await worker.stop()
    }

    const records = await sixb.broker.read({
      projectId: sixb.id,
      streamId: LOGS_STREAM.id,
      names: ["pipeline"],
    })
    const line = records.find(
      (record) => (record.payload as { message?: string }).message === "Cleaning customers"
    )
    expect(line?.key).toBe("run-log")
    const payload = line?.payload as {
      level: string
      fields?: { phase?: string; step?: string }
      run?: { kind?: string; id?: string }
    }
    expect(payload.level).toBe("info")
    expect(payload.fields?.phase).toBe("clean")
    expect(payload.fields?.step).toBe("clean-customers")
    expect(payload.run).toEqual({ kind: "pipeline", id: "run-log" })
  })

  test("processes queued JS pipeline jobs and emits lineage events", async () => {
    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output }) => {
        await output.writeRows(inputs.rawCustomers.readRows())
      })
    const pipeline = definePipeline("customers").then(cleanStep)
    const sixb = createSixbForPipeline({
      pipeline,
      datasets: [rawCustomersDataset, customersDataset],
    })
    await seedDatasetVersion(sixb.lakeStorage as InMemoryLakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada" },
      { id: "cust_2", name: "Grace" },
    ])

    const worker = new PipelineWorker(sixb)
    await sixb.queues.pipelines.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "pipeline.run.requested",
          payload: {
            pipelineId: "customers",
            runId: "run-queued",
          },
        },
      ],
    })

    await worker.start()

    try {
      const run = await waitFor(
        () => sixb.storage.pipelineRuns!.getById({ projectId: sixb.id, id: "run-queued" }),
        (value) => value?.status === "succeeded"
      )

      expect(run?.output?.datasetId).toBe("customers")

      const claimed = await sixb.queues.pipelines.claim({
        projectId: sixb.id,
        workerId: "observer",
      })
      expect(claimed).toHaveLength(0)
    } finally {
      await worker.stop()
    }

    const events = await sixb.events.read({
      types: [
        "pipeline.run.started",
        "pipeline.run.step.started",
        "pipeline.run.step.finished",
        "dataset.version.committed",
        "pipeline.run.finished",
      ],
    })

    expect(events.map((event) => event.type)).toEqual([
      "pipeline.run.started",
      "pipeline.run.step.started",
      "pipeline.run.step.finished",
      "dataset.version.committed",
      "pipeline.run.finished",
    ])
    expect(events[0]?.payload).toMatchObject({
      pipelineId: "customers",
      runId: "run-queued",
    })
    expect(events[1]?.payload).toMatchObject({
      pipelineId: "customers",
      runId: "run-queued",
      stepRunId: "run-queued:step:1:clean-customers",
      stepId: "clean-customers",
      stepIndex: 0,
      totalSteps: 1,
      datasetId: "customers",
    })
    expect(events[2]?.payload).toMatchObject({
      pipelineId: "customers",
      runId: "run-queued",
      stepRunId: "run-queued:step:1:clean-customers",
      stepId: "clean-customers",
      status: "succeeded",
      datasetId: "customers",
      rowsWritten: 2,
    })

    const datasetPayload = events[3]?.payload as {
      datasetId: string
      versionId: string
      producer: { kind: string; id?: string; runId?: string; stepId?: string }
    }
    expect(datasetPayload).toMatchObject({
      datasetId: "customers",
      producer: {
        kind: "pipeline",
        id: "customers",
        runId: "run-queued",
        stepId: "clean-customers",
      },
    })

    const finishedPayload = events[4]?.payload as {
      pipelineId: string
      runId: string
      status: string
      datasetId?: string
      versionId?: string
    }
    expect(finishedPayload).toEqual({
      pipelineId: "customers",
      runId: "run-queued",
      status: "succeeded",
      datasetId: "customers",
      versionId: datasetPayload.versionId,
    })
  })

  test("emits committed step events before failing a later step", async () => {
    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output }) => {
        await output.writeRows(inputs.rawCustomers.readRows())
      })
    const failingStep = definePipelineStep("explode")
      .inputs({ customers: customersDataset })
      .output(defineDataset("failed_output", { schema: [col("id", "string")] }))
      .run(() => {
        throw new Error("nope")
      })
    const pipeline = definePipeline("customers").then(cleanStep).then(failingStep)
    const sixb = createSixbForPipeline({
      pipeline,
      datasets: [rawCustomersDataset, customersDataset, failingStep.output],
    })
    await seedDatasetVersion(sixb.lakeStorage as InMemoryLakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada" },
    ])

    const worker = new PipelineWorker(sixb)
    await sixb.queues.pipelines.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "pipeline.run.requested",
          payload: {
            pipelineId: "customers",
            runId: "run-fails-late",
          },
        },
      ],
    })

    await worker.start()

    try {
      await waitFor(
        () => sixb.storage.pipelineRuns!.getById({ projectId: sixb.id, id: "run-fails-late" }),
        (value) => value?.status === "failed"
      )

      const claimed = await sixb.queues.pipelines.claim({
        projectId: sixb.id,
        workerId: "observer",
      })
      expect(claimed).toHaveLength(0)
    } finally {
      await worker.stop()
    }

    const events = await sixb.events.read({
      types: [
        "pipeline.run.started",
        "pipeline.run.step.started",
        "pipeline.run.step.finished",
        "dataset.version.committed",
        "pipeline.run.finished",
      ],
    })

    expect(events.map((event) => event.type)).toEqual([
      "pipeline.run.started",
      "pipeline.run.step.started",
      "pipeline.run.step.finished",
      "dataset.version.committed",
      "pipeline.run.step.started",
      "pipeline.run.step.finished",
      "pipeline.run.finished",
    ])

    expect(events[5]?.payload).toMatchObject({
      pipelineId: "customers",
      runId: "run-fails-late",
      stepRunId: "run-fails-late:step:2:explode",
      stepId: "explode",
      stepIndex: 1,
      totalSteps: 2,
      status: "failed",
      error: "nope",
    })

    const datasetPayload = events[3]?.payload as {
      datasetId: string
      producer: { kind: string; id?: string; runId?: string; stepId?: string }
    }
    expect(datasetPayload).toMatchObject({
      datasetId: "customers",
      producer: {
        kind: "pipeline",
        id: "customers",
        runId: "run-fails-late",
        stepId: "clean-customers",
      },
    })

    const finishedPayload = events[6]?.payload as {
      pipelineId: string
      runId: string
      status: string
      datasetId?: string
      versionId?: string
    }
    expect(finishedPayload.pipelineId).toBe("customers")
    expect(finishedPayload.runId).toBe("run-fails-late")
    expect(finishedPayload.status).toBe("failed")
    expect(finishedPayload.datasetId).toBeUndefined()
    expect(finishedPayload.versionId).toBeUndefined()
  })

  test("fails an aborted queue job after a step has committed", async () => {
    const firstStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output }) => {
        await output.writeRows(inputs.rawCustomers.readRows())
      })
    const abortingStep = definePipelineStep("abort")
      .inputs({ customers: customersDataset })
      .output(defineDataset("never_written", { schema: [col("id", "string")] }))
      .run(() => {
        const error = new Error("aborted")
        error.name = "AbortError"
        throw error
      })
    const pipeline = definePipeline("customers").then(firstStep).then(abortingStep)
    const sixb = createSixbForPipeline({
      pipeline,
      datasets: [rawCustomersDataset, customersDataset, abortingStep.output],
    })
    await seedDatasetVersion(sixb.lakeStorage as InMemoryLakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada" },
    ])

    const worker = new PipelineWorker(sixb)
    await sixb.queues.pipelines.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "pipeline.run.requested",
          payload: {
            pipelineId: "customers",
            runId: "run-aborts-late",
          },
        },
      ],
    })

    await worker.start()

    try {
      await waitFor(
        () => sixb.storage.pipelineRuns!.getById({ projectId: sixb.id, id: "run-aborts-late" }),
        (value) => value?.status === "cancelled"
      )

      const claimed = await sixb.queues.pipelines.claim({
        projectId: sixb.id,
        workerId: "observer",
      })
      expect(claimed).toHaveLength(0)
    } finally {
      await worker.stop()
    }

    const events = await sixb.events.read({
      types: [
        "pipeline.run.started",
        "pipeline.run.step.started",
        "pipeline.run.step.finished",
        "dataset.version.committed",
        "pipeline.run.finished",
      ],
    })

    expect(events.map((event) => event.type)).toEqual([
      "pipeline.run.started",
      "pipeline.run.step.started",
      "pipeline.run.step.finished",
      "dataset.version.committed",
      "pipeline.run.step.started",
      "pipeline.run.step.finished",
      "pipeline.run.finished",
    ])
    expect(events[5]?.payload).toMatchObject({
      pipelineId: "customers",
      runId: "run-aborts-late",
      stepRunId: "run-aborts-late:step:2:abort",
      status: "cancelled",
    })
    expect(events[6]?.payload).toMatchObject({
      pipelineId: "customers",
      runId: "run-aborts-late",
      status: "cancelled",
    })
  })
})
