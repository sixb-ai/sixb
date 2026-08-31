import { describe, expect, test } from "bun:test"
import type {
  DatasetDefinition,
  DatasetRow,
  PipelineDefinition,
  SixbErrorContext,
  SixbErrorHandler,
} from "@sixb/core"
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
  prop,
  SixbHost,
} from "@sixb/core"
import { LOGS_STREAM } from "@sixb/core/internal/logging"
import type { BeginDatasetWriteInput, LakeWriteSession } from "@sixb/core/lake-storage"
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
  readonly lakeStorage?: InMemoryLakeStorage
  readonly onError?: SixbErrorHandler
}) {
  return new SixbHost({
    id: "pipeline-worker-tests",
    ontology: [Room],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: options.lakeStorage ?? new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: options.datasets,
    pipelines: [options.pipeline],
    onError: options.onError,
  })
}

async function enqueuePipelineRun(
  sixb: Pick<SixbHost, "id" | "storage" | "queues">,
  input: { readonly pipelineId: string; readonly runId: string }
) {
  const executionId = `exec:${input.runId}`
  await sixb.storage.executions.create({
    id: executionId,
    projectId: sixb.id,
    executor: { type: "primitive", kind: "pipeline", runId: input.runId },
    source: { type: "schedule", eventId: `event:${input.runId}` },
    correlationId: `correlation:${input.runId}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "pipeline", id: input.pipelineId, runId: input.runId },
    },
  })
  await sixb.storage.pipelineRuns!.queue({
    id: input.runId,
    projectId: sixb.id,
    executionId,
    pipelineId: input.pipelineId,
  })
  return sixb.queues.pipelines.enqueue({
    projectId: sixb.id,
    jobs: [
      {
        id: input.runId,
        type: "pipeline.run.requested",
        payload: { runId: input.runId },
      },
    ],
  })
}

class ReusingVersionLakeStorage extends InMemoryLakeStorage {
  private reuseNext = false

  reuseNextCommittedVersion(): void {
    this.reuseNext = true
  }

  override async beginWrite(input: BeginDatasetWriteInput): Promise<LakeWriteSession> {
    const write = await super.beginWrite(input)
    if (!this.reuseNext) return write
    this.reuseNext = false

    return {
      writeRows: (rows) => write.writeRows(rows),
      commit: async () => {
        await write.abort()
        const latest = await this.getLatestVersion(input.dataset.id)
        if (!latest) throw new Error("Expected a committed version to reuse.")
        return { ...latest, outcome: "unchanged" }
      },
      abort: () => write.abort(),
    }
  }
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
  test("defaults to one concurrent job and accepts an explicit limit", () => {
    const cleanStep = definePipelineStep("concurrency-options")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async () => {})
    const sixb = createSixbForPipeline({
      pipeline: definePipeline("concurrency-options").then(cleanStep),
      datasets: [rawCustomersDataset, customersDataset],
    })

    expect(new PipelineWorker(sixb).concurrency).toBe(1)
    expect(new PipelineWorker(sixb, { concurrency: 3 }).concurrency).toBe(3)
  })

  test("requires registered pipelines and pipeline run storage", () => {
    const emptySixb = new SixbHost({
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
    const storage = { ...sixb.storage, pipelineRuns: undefined }
    const withoutPipelineRuns = new Proxy(sixb, {
      get(target, property, receiver) {
        return property === "storage" ? storage : Reflect.get(target, property, receiver)
      },
    })
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
    await enqueuePipelineRun(sixb, { pipelineId: "customers", runId: "run-log" })

    await worker.start()
    try {
      await waitFor(
        () => sixb.storage.pipelineRuns!.getById({ projectId: sixb.id, id: "run-log" }),
        (value) => value?.status === "succeeded"
      )
    } finally {
      await worker.stop()
    }

    const { records } = await sixb.broker.read({
      projectId: sixb.id,
      streamId: LOGS_STREAM.id,
      names: ["pipeline.info"],
    })
    const line = records.find(
      (record) => (record.payload as { message?: string }).message === "Cleaning customers"
    )
    expect(line?.key).toBe("pipeline:run-log")
    const payload = line?.payload as {
      level: string
      fields?: { phase?: string }
      context?: { run?: { kind?: string; id?: string }; stepId?: string }
    }
    expect(payload.level).toBe("info")
    expect(payload.fields?.phase).toBe("clean")
    expect(payload.context?.stepId).toBe("clean-customers")
    expect(payload.context?.run).toEqual({ kind: "pipeline", id: "run-log" })
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
    await enqueuePipelineRun(sixb, { pipelineId: "customers", runId: "run-queued" })

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

  test("does not emit a dataset event when a step reuses an existing version", async () => {
    const step = definePipelineStep("copy-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output }) => {
        await output.writeRows(inputs.rawCustomers.readRows())
      })
    const pipeline = definePipeline("customers").then(step)
    const lakeStorage = new ReusingVersionLakeStorage()
    await seedDatasetVersion(lakeStorage, rawCustomersDataset, [{ id: "cust_1", name: "Ada" }])
    const previous = await seedDatasetVersion(lakeStorage, customersDataset, [
      { id: "cust_1", name: "Ada" },
    ])
    lakeStorage.reuseNextCommittedVersion()
    const sixb = createSixbForPipeline({
      pipeline,
      datasets: [rawCustomersDataset, customersDataset],
      lakeStorage,
    })
    const worker = new PipelineWorker(sixb)
    await enqueuePipelineRun(sixb, { pipelineId: pipeline.id, runId: "run-no-op" })

    await worker.start()
    await waitFor(
      () => sixb.storage.pipelineRuns!.getById({ projectId: sixb.id, id: "run-no-op" }),
      (run) => run?.status === "succeeded"
    )
    await Bun.sleep(50)
    await worker.stop()

    const events = await sixb.events.read({
      types: ["pipeline.run.started", "dataset.version.committed", "pipeline.run.finished"],
    })
    expect(events.map((event) => event.type)).toEqual([
      "pipeline.run.started",
      "pipeline.run.finished",
    ])
    expect(events[1]?.payload).toMatchObject({
      pipelineId: pipeline.id,
      runId: "run-no-op",
      status: "succeeded",
      versionId: previous.versionId,
    })
  })

  test("emits committed step events and reports once before failing a later step", async () => {
    const reports: { error: Error; context: SixbErrorContext }[] = []
    const originalError = new Error("nope")
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
        throw originalError
      })
    const pipeline = definePipeline("customers").then(cleanStep).then(failingStep)
    const sixb = createSixbForPipeline({
      pipeline,
      datasets: [rawCustomersDataset, customersDataset, failingStep.output],
      onError(error, context) {
        reports.push({ error, context })
      },
    })
    let settledFailure: unknown
    const fail = sixb.queues.pipelines.fail.bind(sixb.queues.pipelines)
    sixb.queues.pipelines.fail = async (input) => {
      settledFailure = input.failure
      await fail(input)
    }
    await seedDatasetVersion(sixb.lakeStorage as InMemoryLakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada" },
    ])

    const worker = new PipelineWorker(sixb)
    await enqueuePipelineRun(sixb, { pipelineId: "customers", runId: "run-fails-late" })

    await worker.start()

    try {
      const run = await waitFor(
        () => sixb.storage.pipelineRuns!.getById({ projectId: sixb.id, id: "run-fails-late" }),
        (value) => value?.status === "failed"
      )
      await waitFor(
        async () => reports.length,
        (count) => count === 1
      )
      await waitFor(
        async () => settledFailure,
        (failure) => failure !== undefined
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toBe(originalError)
      expect(reports[0]?.context).toEqual({
        type: "run.failed",
        notificationId: `project:${sixb.id}:run:pipeline:run-fails-late:failed:${run!.error!.at}`,
        projectId: sixb.id,
        occurredAt: run!.error!.at,
        attempt: 1,
        runKind: "pipeline",
        run: {
          runId: "run-fails-late",
          pipelineId: pipeline.id,
        },
        failure: run!.error!,
      })
      expect(settledFailure).toEqual(run!.error)

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
      error: {
        code: "pipeline.step_failed",
        message: "Pipeline step execution failed.",
        retryable: false,
        at: expect.any(String),
        details: {
          pipelineId: "customers",
          pipelineRunId: "run-fails-late",
          stepId: "explode",
          stepRunId: "run-fails-late:step:2:explode",
        },
      },
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
      error?: unknown
    }
    const failedRun = await sixb.storage.pipelineRuns!.getById({
      projectId: sixb.id,
      id: "run-fails-late",
    })
    expect(finishedPayload).toEqual({
      pipelineId: "customers",
      runId: "run-fails-late",
      status: "failed",
      error: failedRun?.error,
    })
  })

  test("fails an aborted queue job after a step has committed without reporting it", async () => {
    let reportCount = 0
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
      onError() {
        reportCount += 1
      },
    })
    await seedDatasetVersion(sixb.lakeStorage as InMemoryLakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada" },
    ])

    const worker = new PipelineWorker(sixb)
    await enqueuePipelineRun(sixb, { pipelineId: "customers", runId: "run-aborts-late" })

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
    const cancelledRun = await sixb.storage.pipelineRuns!.getById({
      projectId: sixb.id,
      id: "run-aborts-late",
    })
    const [cancelledStep] = (
      await sixb.storage.pipelineRuns!.listSteps({
        projectId: sixb.id,
        pipelineRunId: "run-aborts-late",
        statuses: ["cancelled"],
      })
    ).steps
    expect(cancelledRun?.error).toMatchObject({
      code: "runtime.cancelled",
      retryable: false,
    })
    expect(cancelledStep?.error).toMatchObject({
      code: "runtime.cancelled",
      retryable: false,
    })
    expect(events[5]?.payload).toMatchObject({ error: cancelledStep?.error })
    expect(events[6]?.payload).toMatchObject({ error: cancelledRun?.error })
    expect(reportCount).toBe(0)
  })
})
