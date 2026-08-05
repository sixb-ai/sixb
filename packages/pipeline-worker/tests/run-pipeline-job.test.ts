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
} from "@sixb/core"
import type {
  DatasetWriteMode,
  ExecuteSqlTransformInput,
  LakeSqlTransformCapabilities,
} from "@sixb/core/lake-storage"
import type { PipelineRunStorage } from "@sixb/core/storage"
import { InMemoryPipelineRunStorage } from "@sixb/core/storage"
import { runPipelineJob } from "../src/run-pipeline-job"
import type { PipelineWorkerContext } from "../src/types"

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
    pipelineRunsStorage: options.pipelineRunsStorage ?? new InMemoryPipelineRunStorage(),
    lakeStorage: options.lakeStorage ?? new InMemoryLakeStorage(),
    getPipelineById(pipelineId) {
      return pipelinesById.get(pipelineId) ?? null
    },
    getDatasetById(datasetId) {
      return datasetsById.get(datasetId) ?? null
    },
  }
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
    ).rejects.toThrow("[SixbPipelineWorker] Unknown pipeline 'missing'.")
  })

  test("fails clearly when an input has no committed version", async () => {
    const cleanStep = definePipelineStep("clean-customers")
      .inputs({ rawCustomers: rawCustomersDataset })
      .output(customersDataset)
      .run(async () => {})
    const pipeline = definePipeline("customers").then(cleanStep)
    const pipelineRunsStorage = new InMemoryPipelineRunStorage()
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
    ).rejects.toThrow(
      "[SixbPipelineWorker] Pipeline 'customers' step 'clean-customers' input 'rawCustomers' dataset 'raw.customers' has no committed version."
    )

    const run = await pipelineRunsStorage.getById({
      projectId: runtime.id,
      id: "run_missing_input",
    })
    expect(run?.status).toBe("failed")
    expect(run?.error).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      details: { pipelineId: "customers", runId: "run_missing_input" },
    })
    expect(run?.error?.message).toContain("has no committed version")

    const steps = await pipelineRunsStorage.listSteps({
      projectId: runtime.id,
      pipelineRunId: "run_missing_input",
    })
    expect(steps.steps).toHaveLength(0)
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
    const pipelineRunsStorage = new InMemoryPipelineRunStorage()
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customersDataset],
      lakeStorage,
      pipelineRunsStorage,
    })

    const result = await runPipelineJob({
      runtime,
      job: {
        id: "run_clean",
        pipelineId: "customers",
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
    const pipelineRunsStorage = new InMemoryPipelineRunStorage()
    const runtime = createRuntime({
      pipelines: [pipeline],
      datasets: [rawCustomersDataset, customersDataset, customerStatsDataset],
      lakeStorage,
      pipelineRunsStorage,
    })

    await expect(
      runPipelineJob({
        runtime,
        job: {
          id: "run_failure",
          pipelineId: "customers",
        },
      })
    ).rejects.toThrow("stats exploded")

    const run = await pipelineRunsStorage.getById({
      projectId: runtime.id,
      id: "run_failure",
    })
    expect(run?.status).toBe("failed")
    expect(run?.output).toBeUndefined()

    const stepRuns = await pipelineRunsStorage.listSteps({
      projectId: runtime.id,
      pipelineRunId: "run_failure",
      order: "asc",
    })
    expect(stepRuns.steps.map((step) => step.status)).toEqual(["succeeded", "failed"])
    expect(run?.error).toMatchObject({
      code: "internal.unexpected",
      details: { pipelineId: "customers", runId: "run_failure" },
    })
    expect(stepRuns.steps[1]?.error).toMatchObject({
      code: "internal.unexpected",
      details: {
        pipelineId: "customers",
        pipelineRunId: "run_failure",
        stepId: "customer-stats",
        stepRunId: "run_failure:step:2:customer-stats",
      },
    })
    expect(stepRuns.steps[1]?.error?.message).toBe("stats exploded")

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
    ).rejects.toThrow("writes in 'append' mode, which the duckdb SQL executor does not support")
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
    const pipelineRunsStorage = new InMemoryPipelineRunStorage()

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
    ).rejects.toThrow(
      "[SixbPipelineWorker] Pipeline 'customers' step 'customer-stats' requires SQL transform support, but lake storage does not provide lakeStorage.sql.execute(...)."
    )

    const run = await pipelineRunsStorage.getById({
      projectId: runtime.id,
      id: "run_sql_no_support",
    })
    expect(run?.status).toBe("failed")

    const stepRuns = await pipelineRunsStorage.listSteps({
      projectId: runtime.id,
      pipelineRunId: "run_sql_no_support",
    })
    expect(stepRuns.steps[0]).toMatchObject({
      stepId: "customer-stats",
      status: "failed",
      error: {
        code: "internal.unexpected",
        retryable: false,
      },
    })
    expect(stepRuns.steps[0]?.error?.message).toContain("requires SQL transform support")
  })
})
