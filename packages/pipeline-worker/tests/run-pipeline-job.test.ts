import { describe, expect, test } from "bun:test"
import type {
  DatasetDefinition,
  DatasetRow,
  LakeStorage,
  LakeStorageWithSql,
  PipelineDefinition,
} from "@sixb/core"
import {
  col,
  defineDataset,
  definePipeline,
  definePipelineStep,
  InMemoryLakeStorage,
  InMemoryStorage,
} from "@sixb/core"
import type {
  DatasetWriteMode,
  ExecuteSqlTransformInput,
  LakeSqlTransformCapabilities,
} from "@sixb/core/lake-storage"
import type {
  ExecutionStorage,
  FinishPipelineRunInput,
  PipelineRunRecord,
  PipelineRunStorage,
} from "@sixb/core/storage"
import { InMemoryPipelineRunStorage } from "@sixb/core/storage"
import { createPipelineBookkeepingError, createStepBookkeepingError } from "../src/errors"
import { runPipelineJob as runPipelineJobWithDurableRun } from "../src/run-pipeline-job"
import type { PipelineWorkerContext, RunPipelineJobInput } from "../src/types"

const executionsByRunStorage = new WeakMap<PipelineRunStorage, ExecutionStorage>()

const rawCustomersDataset = defineDataset("raw.customers", {
  schema: [col("id", "string"), col("name", "string"), col("email", "string", { nullable: true })],
})

const customersDataset = defineDataset("customers", {
  schema: [col("id", "string"), col("name", "string")],
})

const customerStatsDataset = defineDataset("customer_stats", {
  schema: [col("metric", "string"), col("value", "int64")],
})

function createRuntime(options: {
  readonly pipelines?: readonly PipelineDefinition[]
  readonly datasets?: readonly DatasetDefinition[]
  readonly lakeStorage?: LakeStorage
  readonly pipelineRunsStorage?: PipelineRunStorage
}): PipelineWorkerContext {
  const pipelinesById = new Map(
    (options.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline])
  )
  const datasetsById = new Map((options.datasets ?? []).map((dataset) => [dataset.id, dataset]))

  return {
    id: "project-1",
    pipelineRunsStorage: options.pipelineRunsStorage ?? createPipelineRunStorage(),
    lakeStorage: options.lakeStorage ?? new InMemoryLakeStorage(),
    pipelines: {
      getById(pipelineId) {
        return pipelinesById.get(pipelineId) ?? null
      },
    },
    datasets: {
      getById(datasetId) {
        return datasetsById.get(datasetId) ?? null
      },
    },
  }
}

function createPipelineRunStorage(): PipelineRunStorage {
  const provider = new InMemoryStorage()
  executionsByRunStorage.set(provider.pipelineRuns, provider.executions)
  return provider.pipelineRuns
}

interface TestPipelineJob {
  readonly id: string
  readonly pipelineId: string
}

type TestRunPipelineJobInput = Omit<RunPipelineJobInput, "run"> & {
  readonly job: TestPipelineJob
}

async function queueTestPipelineRun(runtime: PipelineWorkerContext, job: TestPipelineJob) {
  const existing = await runtime.pipelineRunsStorage.getById({
    projectId: runtime.id,
    id: job.id,
  })
  if (existing) return existing

  const executions = executionsByRunStorage.get(runtime.pipelineRunsStorage)
  if (!executions) throw new Error("[Test] Pipeline run storage has no execution storage.")
  const executionId = `exec:${job.id}`
  await executions.create({
    id: executionId,
    projectId: runtime.id,
    executor: { type: "primitive", kind: "pipeline", runId: job.id },
    source: { type: "schedule", eventId: `event:${job.id}` },
    correlationId: `correlation:${job.id}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "pipeline", id: job.pipelineId, runId: job.id },
    },
  })
  return runtime.pipelineRunsStorage.queue({
    id: job.id,
    projectId: runtime.id,
    executionId,
    pipelineId: job.pipelineId,
  })
}

async function runPipelineJob(input: TestRunPipelineJobInput) {
  const { job, ...options } = input
  const run = await queueTestPipelineRun(input.runtime, job)
  return runPipelineJobWithDurableRun({ ...options, run })
}

async function seedDatasetVersion(
  lakeStorage: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  mode: DatasetWriteMode = "snapshot"
) {
  await lakeStorage.createDataset(dataset)
  const write = await lakeStorage.beginWrite({ dataset, mode })
  await write.writeRows(rows)
  return write.commit({ commitMessage: `seed ${dataset.id}` })
}

async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of rows) {
    result.push(row)
  }
  return result
}

const ALL_SQL_CAPABILITIES: LakeSqlTransformCapabilities = {
  preview: true,
  supportsAppend: true,
  supportsSnapshot: true,
}

class SqlTransformLakeStorage extends InMemoryLakeStorage implements LakeStorageWithSql<"duckdb"> {
  readonly executeCalls: ExecuteSqlTransformInput<"duckdb">[] = []
  readonly sql: LakeStorageWithSql<"duckdb">["sql"]

  constructor(capabilities: LakeSqlTransformCapabilities = ALL_SQL_CAPABILITIES) {
    super()
    this.sql = { ...this.sqlBase, capabilities }
  }

  private readonly sqlBase = {
    dialect: "duckdb" as const,
    capabilities: ALL_SQL_CAPABILITIES,
    preview: async function* (): AsyncIterable<DatasetRow> {},
    execute: async (input: ExecuteSqlTransformInput<"duckdb">) => {
      this.executeCalls.push(input)

      const write = await this.beginWrite({
        dataset: input.target,
        mode: input.mode,
        producer: input.producer,
        inputs: Object.values(input.sources)
          .filter((source): source is typeof source & { versionId: string } =>
            Boolean(source.versionId)
          )
          .map((source) => ({
            datasetId: source.dataset.id,
            versionId: source.versionId,
          })),
      })
      await write.writeRows([{ metric: "sql_rows", value: 1 }])
      return write.commit({
        commitMessage: input.commitMessage,
        expectedLatestVersionId: input.expectedLatestVersionId,
      })
    },
  }
}

class RejectingFinishPipelineRunStorage extends InMemoryPipelineRunStorage {
  override async finish(_input: FinishPipelineRunInput): Promise<PipelineRunRecord> {
    throw new Error("pipeline run storage unavailable")
  }
}

describe("runPipelineJob", () => {
  test("fails clearly when the pipeline is missing", async () => {
    const runtime = createRuntime({})

    await expect(
      runPipelineJob({
        runtime,
        job: {
          id: "run_1",
          pipelineId: "missing",
        },
      })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message: "[SixbPipelineWorker] Unknown pipeline 'missing'.",
      details: { pipelineId: "missing", runId: "run_1" },
    })
  })

  test("preserves causes and correlation details for post-commit bookkeeping failures", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const { outcome: _outcome, ...version } = await seedDatasetVersion(
      lakeStorage,
      customersDataset,
      [{ id: "cust_1", name: "Ada" }]
    )
    const stepCause = new Error("step finish unavailable")
    const stepError = createStepBookkeepingError({
      pipelineId: "customers",
      pipelineRunId: "run_1",
      stepId: "clean-customers",
      stepRunId: "run_1:step:1:clean-customers",
      version,
      cause: stepCause,
    })

    expect(stepError).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      cause: stepCause,
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_1",
        stepId: "clean-customers",
        stepRunId: "run_1:step:1:clean-customers",
        datasetId: "customers",
        versionId: version.versionId,
      },
    })

    const runCause = new Error("pipeline finish unavailable")
    const runError = createPipelineBookkeepingError({
      pipelineId: "customers",
      runId: "run_1",
      version,
      cause: runCause,
    })
    expect(runError).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      cause: runCause,
      details: {
        pipelineId: "customers",
        runId: "run_1",
        datasetId: "customers",
        versionId: version.versionId,
      },
    })
  })

  test("keeps step finalization failures out of the step-failed vocabulary", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    await seedDatasetVersion(lakeStorage, rawCustomersDataset, [{ id: "cust_1", name: "Ada" }])
    const step = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output }) => {
        await output.writeRows(inputs.rawCustomers.readRows({ columns: ["id", "name"] }))
      })
    const pipeline = definePipeline("customers").then(step)
    const pipelineRunsStorage = createPipelineRunStorage()
    const finishStep = pipelineRunsStorage.finishStep.bind(pipelineRunsStorage)
    const finishCause = new Error("step finish unavailable")
    pipelineRunsStorage.finishStep = async (input) => {
      if (input.status === "succeeded") throw finishCause
      return finishStep(input)
    }
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customersDataset],
      lakeStorage,
      pipelineRunsStorage,
    })

    await expect(
      runPipelineJob({ runtime, job: { id: "run_step_finish_failed", pipelineId: pipeline.id } })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      cause: finishCause,
      details: {
        pipelineId: pipeline.id,
        pipelineRunId: "run_step_finish_failed",
        stepId: step.id,
        stepRunId: "run_step_finish_failed:step:1:clean-customers",
      },
    })

    const run = await pipelineRunsStorage.getById({
      projectId: runtime.id,
      id: "run_step_finish_failed",
    })
    expect(run?.error).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      details: {
        pipelineId: pipeline.id,
        pipelineRunId: "run_step_finish_failed",
        stepId: step.id,
        stepRunId: "run_step_finish_failed:step:1:clean-customers",
      },
    })
  })

  test("fails clearly when an input has no committed version", async () => {
    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async () => {})
    const pipeline = definePipeline("customers").then(cleanStep)
    const pipelineRunsStorage = createPipelineRunStorage()
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customersDataset],
      pipelineRunsStorage,
    })

    await expect(
      runPipelineJob({
        runtime,
        job: {
          id: "run_missing_input",
          pipelineId: "customers",
        },
      })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message:
        "[SixbPipelineWorker] Pipeline 'customers' step 'clean-customers' input 'rawCustomers' dataset 'raw.customers' has no committed version.",
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_missing_input",
        stepId: "clean-customers",
        datasetId: "raw.customers",
      },
    })

    const run = await pipelineRunsStorage.getById({
      projectId: runtime.id,
      id: "run_missing_input",
    })
    expect(run?.status).toBe("failed")
    expect(run?.error).toMatchObject({
      code: "pipeline.step_failed",
      retryable: false,
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_missing_input",
        stepId: "clean-customers",
      },
    })
    expect(run?.error?.message).toBe("Pipeline step execution failed.")

    const steps = await pipelineRunsStorage.listSteps({
      projectId: runtime.id,
      pipelineRunId: "run_missing_input",
    })
    expect(steps.steps).toHaveLength(0)
  })

  test("does not notify a terminal run when the durable transition fails", async () => {
    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async () => {})
    const provider = new InMemoryStorage()
    const pipelineRunsStorage = new RejectingFinishPipelineRunStorage(provider.executions)
    executionsByRunStorage.set(pipelineRunsStorage, provider.executions)
    const runtime = createRuntime({
      pipelines: [definePipeline("customers").then(cleanStep)],
      datasets: [rawCustomersDataset, customersDataset],
      pipelineRunsStorage,
    })
    const finishedRuns: PipelineRunRecord[] = []

    await expect(
      runPipelineJob({
        runtime,
        job: { id: "run_finish_rejected", pipelineId: "customers" },
        onRunFinished(run) {
          finishedRuns.push(run)
        },
      })
    ).rejects.toThrow("has no committed version")

    expect(finishedRuns).toHaveLength(0)
    expect(
      await pipelineRunsStorage.getById({ projectId: runtime.id, id: "run_finish_rejected" })
    ).toMatchObject({ status: "running" })
  })

  test("runs a JS step with pinned input readers and commits one output version", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const seededVersion = await seedDatasetVersion(lakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada", email: "ada@example.com" },
      { id: "cust_2", name: "Grace", email: "grace@example.com" },
    ])

    let seenInputVersionId: string | undefined
    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output }) => {
        seenInputVersionId = inputs.rawCustomers.version.versionId

        await seedDatasetVersion(lakeStorage, rawCustomersDataset, [
          { id: "cust_3", name: "Katherine", email: "katherine@example.com" },
        ])

        const rows: DatasetRow[] = []
        for await (const row of inputs.rawCustomers.readRows({ columns: ["id", "name"] })) {
          rows.push(row)
        }

        await output.writeRows(rows)
      })
    const pipeline = definePipeline("customers").then(cleanStep)
    const pipelineRunsStorage = createPipelineRunStorage()
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customersDataset],
      lakeStorage,
      pipelineRunsStorage,
    })
    const finishedRuns: PipelineRunRecord[] = []

    const result = await runPipelineJob({
      runtime,
      job: {
        id: "run_clean",
        pipelineId: "customers",
      },
      onRunFinished(run) {
        finishedRuns.push(run)
      },
    })

    expect(seenInputVersionId).toBe(seededVersion.versionId)
    expect(result.version?.datasetId).toBe("customers")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.run.rowsWritten).toBe(2)
    expect(result.steps[0]?.run.inputs).toEqual([
      {
        datasetId: "raw.customers",
        versionId: seededVersion.versionId,
      },
    ])
    expect(result.version?.inputs).toEqual([
      {
        datasetId: "raw.customers",
        versionId: seededVersion.versionId,
      },
    ])
    expect(result.version?.producer).toEqual({
      kind: "pipeline",
      id: "customers",
      runId: "run_clean",
      stepId: "clean-customers",
    })

    const rows = await collectRows(lakeStorage.readRows({ datasetId: "customers" }))
    expect(rows).toEqual([
      { id: "cust_1", name: "Ada" },
      { id: "cust_2", name: "Grace" },
    ])

    const run = await pipelineRunsStorage.getById({
      projectId: runtime.id,
      id: "run_clean",
    })
    expect(run).toMatchObject({
      status: "succeeded",
      output: {
        datasetId: "customers",
        versionId: result.version?.versionId,
      },
    })
    if (!run) throw new Error("Expected the pipeline run to be persisted.")
    expect(finishedRuns).toEqual([run])

    const stepRuns = await pipelineRunsStorage.listSteps({
      projectId: runtime.id,
      pipelineRunId: "run_clean",
    })
    expect(stepRuns.steps[0]).toMatchObject({
      stepId: "clean-customers",
      datasetId: "customers",
      status: "succeeded",
      rowsWritten: 2,
      output: {
        datasetId: "customers",
        versionId: result.version?.versionId,
      },
    })
  })

  test("runs multiple JS steps in order and lets downstream steps read upstream outputs", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    await seedDatasetVersion(lakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada" },
      { id: "cust_2", name: "Grace" },
      { id: "cust_3", name: "Katherine" },
    ])

    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output }) => {
        const rows: DatasetRow[] = []
        for await (const row of inputs.rawCustomers.readRows({ columns: ["id", "name"] })) {
          rows.push(row)
        }
        await output.writeRows(rows)
      })
    const statsStep = definePipelineStep("customer-stats")
      .inputs({ customers: customersDataset })
      .output(customerStatsDataset)
      .run(async ({ inputs, output }) => {
        let count = 0
        for await (const _row of inputs.customers.readRows()) {
          count += 1
        }
        await output.writeRows([{ metric: "customer_count", value: count }])
      })
    const pipeline = definePipeline("customers").then(cleanStep).then(statsStep)
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customersDataset, customerStatsDataset],
      lakeStorage,
    })

    const result = await runPipelineJob({
      runtime,
      job: {
        id: "run_multistep",
        pipelineId: "customers",
      },
    })

    expect(result.steps.map((step) => step.run.stepId)).toEqual([
      "clean-customers",
      "customer-stats",
    ])
    expect(result.version?.datasetId).toBe("customer_stats")

    const statsRows = await collectRows(lakeStorage.readRows({ datasetId: "customer_stats" }))
    expect(statsRows).toEqual([{ metric: "customer_count", value: 3 }])
  })

  test("marks the active step and pipeline failed when a later step throws", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    await seedDatasetVersion(lakeStorage, rawCustomersDataset, [{ id: "cust_1", name: "Ada" }])

    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async ({ inputs, output }) => {
        await output.writeRows(inputs.rawCustomers.readRows({ columns: ["id", "name"] }))
      })
    const failingStep = definePipelineStep("customer-stats")
      .inputs({ customers: customersDataset })
      .output(customerStatsDataset)
      .run(() => {
        throw new Error("stats exploded")
      })
    const pipeline = definePipeline("customers").then(cleanStep).then(failingStep)
    const pipelineRunsStorage = createPipelineRunStorage()
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customersDataset, customerStatsDataset],
      lakeStorage,
      pipelineRunsStorage,
    })
    const finishedRuns: PipelineRunRecord[] = []

    await expect(
      runPipelineJob({
        runtime,
        job: {
          id: "run_failure",
          pipelineId: "customers",
        },
        onRunFinished(run) {
          finishedRuns.push(run)
        },
      })
    ).rejects.toThrow("stats exploded")

    const run = await pipelineRunsStorage.getById({
      projectId: runtime.id,
      id: "run_failure",
    })
    expect(run?.status).toBe("failed")
    expect(run?.output).toBeUndefined()
    if (!run) throw new Error("Expected the failed pipeline run to be persisted.")
    expect(finishedRuns).toEqual([run])

    const stepRuns = await pipelineRunsStorage.listSteps({
      projectId: runtime.id,
      pipelineRunId: "run_failure",
      order: "asc",
    })
    expect(stepRuns.steps.map((step) => step.status)).toEqual(["succeeded", "failed"])
    expect(run?.error).toMatchObject({
      code: "pipeline.step_failed",
      retryable: false,
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_failure",
        stepId: "customer-stats",
        stepRunId: "run_failure:step:2:customer-stats",
      },
    })
    expect(stepRuns.steps[1]?.error).toMatchObject({
      code: "pipeline.step_failed",
      retryable: false,
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_failure",
        stepId: "customer-stats",
        stepRunId: "run_failure:step:2:customer-stats",
      },
    })
    expect(stepRuns.steps[1]?.error?.message).toBe("Pipeline step execution failed.")

    const committedRows = await collectRows(lakeStorage.readRows({ datasetId: "customers" }))
    expect(committedRows).toEqual([{ id: "cust_1", name: "Ada" }])
  })

  test("refuses a write mode the SQL executor declares it cannot do", async () => {
    // `LakeSqlExecutor.capabilities` is a required field on the contract that nothing read.
    // A provider declaring `supportsAppend: false` was asked to be honest and then ignored,
    // so the step reached `execute()` and failed in whatever words that provider used.
    const lakeStorage = new SqlTransformLakeStorage({
      preview: true,
      supportsAppend: false,
      supportsSnapshot: true,
    })
    await seedDatasetVersion(lakeStorage, rawCustomersDataset, [{ id: "cust_1", name: "Ada" }])
    await lakeStorage.createDataset(customerStatsDataset)

    const statsStep = definePipelineStep("customer-stats")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customerStatsDataset, { mode: "append" })
      .sql(({ rawCustomers }) => `select count(*) as value from ${rawCustomers}`)
    const runtime = createRuntime({
      pipelines: [definePipeline("customers").then(statsStep)],
      datasets: [rawCustomersDataset, customerStatsDataset],
      lakeStorage,
    })

    await expect(
      runPipelineJob({ runtime, job: { id: "run_sql", pipelineId: "customers" } })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message:
        "[SixbPipelineWorker] Pipeline 'customers' step 'customer-stats' writes in 'append' mode, which the duckdb SQL executor does not support.",
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_sql",
        stepId: "customer-stats",
        datasetId: "customer_stats",
      },
    })
    // Refused before the provider was asked to do it, so nothing was written or committed.
    expect(lakeStorage.executeCalls).toHaveLength(0)
  })

  test("executes SQL steps through lakeStorage.sql.execute with pinned sources", async () => {
    const lakeStorage = new SqlTransformLakeStorage()
    const seededVersion = await seedDatasetVersion(lakeStorage, rawCustomersDataset, [
      { id: "cust_1", name: "Ada", email: "ada@example.com" },
    ])
    await lakeStorage.createDataset(customerStatsDataset)

    const statsStep = definePipelineStep("customer-stats")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customerStatsDataset, { mode: "append" })
      .sql(({ rawCustomers }) => `select count(*) as value from ${rawCustomers}`)
    const pipeline = definePipeline("customers").then(statsStep)
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customerStatsDataset],
      lakeStorage,
    })

    const result = await runPipelineJob({
      runtime,
      job: {
        id: "run_sql",
        pipelineId: "customers",
      },
    })

    expect(lakeStorage.executeCalls).toHaveLength(1)
    expect(lakeStorage.executeCalls[0]).toMatchObject({
      target: customerStatsDataset,
      mode: "append",
      producer: {
        kind: "pipeline",
        id: "customers",
        runId: "run_sql",
        stepId: "customer-stats",
      },
      commitMessage: "pipeline customers step customer-stats run run_sql",
    })
    expect(lakeStorage.executeCalls[0]?.sources.rawCustomers).toEqual({
      dataset: rawCustomersDataset,
      versionId: seededVersion.versionId,
    })

    expect(result.version?.producer).toEqual({
      kind: "pipeline",
      id: "customers",
      runId: "run_sql",
      stepId: "customer-stats",
    })
    expect(result.version?.inputs).toEqual([
      {
        datasetId: "raw.customers",
        versionId: seededVersion.versionId,
      },
    ])
    expect(result.steps[0]?.run).toMatchObject({
      stepId: "customer-stats",
      datasetId: "customer_stats",
      status: "succeeded",
      rowsWritten: 1,
      inputs: [
        {
          datasetId: "raw.customers",
          versionId: seededVersion.versionId,
        },
      ],
      output: {
        datasetId: "customer_stats",
        versionId: result.version?.versionId,
      },
    })
  })

  test("fails SQL steps clearly when lake storage has no SQL transform support", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    await seedDatasetVersion(lakeStorage, rawCustomersDataset, [{ id: "cust_1", name: "Ada" }])
    const pipelineRunsStorage = createPipelineRunStorage()

    const statsStep = definePipelineStep("customer-stats")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customerStatsDataset)
      .sql(({ rawCustomers }) => `select count(*) as value from ${rawCustomers}`)
    const pipeline = definePipeline("customers").then(statsStep)
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customerStatsDataset],
      lakeStorage,
      pipelineRunsStorage,
    })

    await expect(
      runPipelineJob({
        runtime,
        job: {
          id: "run_sql_no_support",
          pipelineId: "customers",
        },
      })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message:
        "[SixbPipelineWorker] Pipeline 'customers' step 'customer-stats' requires SQL transform support, but lake storage does not provide lakeStorage.sql.execute(...).",
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_sql_no_support",
        stepId: "customer-stats",
        datasetId: "customer_stats",
      },
    })

    const run = await pipelineRunsStorage.getById({
      projectId: runtime.id,
      id: "run_sql_no_support",
    })
    expect(run?.status).toBe("failed")
    expect(run?.error).toMatchObject({
      code: "pipeline.step_failed",
      retryable: false,
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_sql_no_support",
        stepId: "customer-stats",
        stepRunId: "run_sql_no_support:step:1:customer-stats",
      },
    })

    const stepRuns = await pipelineRunsStorage.listSteps({
      projectId: runtime.id,
      pipelineRunId: "run_sql_no_support",
    })
    expect(stepRuns.steps[0]).toMatchObject({
      stepId: "customer-stats",
      status: "failed",
      error: {
        code: "pipeline.step_failed",
        retryable: false,
        details: {
          pipelineId: "customers",
          pipelineRunId: "run_sql_no_support",
          stepId: "customer-stats",
          stepRunId: "run_sql_no_support:step:1:customer-stats",
        },
      },
    })
    expect(stepRuns.steps[0]?.error?.message).toBe("Pipeline step execution failed.")
  })
})
