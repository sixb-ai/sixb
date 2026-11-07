import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  col,
  type DatasetRow,
  defineDataset,
  definePipeline,
  definePipelineStep,
  defineSchedule,
  events,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { PipelineRunDispatcher } from "@sixb/core/internal/pipelines"
import { startTestPipelineRun } from "@sixb/core/testing"
import { compileRoutesWithDiagnostics, createReconciliationPasses } from "@sixb/orchestrator"
import type { DuckLakeStorage } from "../src"
import { createLocalDuckLakeStorage } from "./test-utils"

const INTERVAL_MS = 30_000
const signal = new AbortController().signal

const orders = defineDataset("raw.orders", {
  schema: [col("id", "string"), col("value", "string")],
})
const ordersWithNote = defineDataset("raw.orders", {
  schema: [col("id", "string"), col("value", "string"), col("note", "string", { nullable: true })],
})
const report = defineDataset("orders.report", { schema: [col("id", "string")] })

const ordersUpdated = defineSchedule("orders.updated").on(events.dataset(orders).updated())
const buildReport = definePipeline("build-report")
  .when(ordersUpdated)
  .then(
    definePipelineStep("report")
      .inputs({ orders })
      .output(report)
      .run(() => {})
  )

/**
 * The `triggers` pass on a real lake: what the in-memory lake cannot show is DuckLake's own change
 * feed, the order of its versions, its row counts, and its schema-only versions.
 */
describe("dataset triggers on DuckLake", () => {
  let rootDir: string
  let lake: DuckLakeStorage
  let storage: InMemoryStorage
  let host: SixbHost
  let inputs = 0
  let clock = 0

  beforeEach(async () => {
    clock = Date.now()
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-triggers-"))
    lake = createLocalDuckLakeStorage(rootDir)
    await lake.createDataset(orders)

    storage = new InMemoryStorage()
    host = new SixbHost({
      id: "project",
      ontology: [],
      datasets: [orders, report],
      pipelines: [buildReport],
      schedules: [ordersUpdated],
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      storage,
      lakeStorage: lake,
      blobStorage: new InMemoryBlobStorage(),
    })
  })

  afterEach(async () => {
    setSystemTime()
    await lake.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  /** Moves the process's clock past the wait for an event, and past the shared feed's interval. */
  function letTheEventBeLost(): void {
    clock += 2 * INTERVAL_MS
    setSystemTime(new Date(clock))
  }

  /** Each write names a new input version, so identical rows still create a version. */
  async function commit(rows: readonly DatasetRow[]): Promise<string> {
    inputs += 1
    const write = await lake.beginWrite({
      dataset: orders,
      mode: "snapshot",
      inputs: [{ datasetId: "upstream", versionId: `ducklake:${inputs}` }],
    })
    await write.writeRows(rows)
    const version = await write.commit()
    expect(version.outcome).toBe("created")
    return version.versionId
  }

  async function runThatRead(versionId: string): Promise<void> {
    await startTestPipelineRun(storage, {
      id: `read-${versionId}`,
      projectId: "project",
      pipelineId: buildReport.id,
      startedAt: new Date(clock),
    })
    await storage.pipelineRuns.startStep({
      id: `read-${versionId}:step`,
      projectId: "project",
      pipelineRunId: `read-${versionId}`,
      pipelineId: buildReport.id,
      stepId: "report",
      datasetId: report.id,
      mode: "snapshot",
      inputs: [{ datasetId: orders.id, versionId }],
    })
    await storage.pipelineRuns.finish({
      id: `read-${versionId}`,
      projectId: "project",
      status: "succeeded",
    })
  }

  /** The passes `sixb orchestrator` would run: a fresh one starts as a restart does. */
  function triggersPass() {
    const { routes } = compileRoutesWithDiagnostics({
      schedules: [ordersUpdated],
      syncs: [],
      pipelines: [buildReport],
    })
    const [pass] = createReconciliationPasses({
      projectId: "project",
      routes,
      dispatchers: { pipelines: new PipelineRunDispatcher(host) },
      lakeStorage: lake,
      datasetTriggers: { lakeStorage: lake, pipelineRuns: storage.pipelineRuns },
    })
    if (pass?.id !== "triggers") throw new Error("Expected the triggers pass.")
    return pass
  }

  async function recoveredVersions(): Promise<readonly string[]> {
    const { runs } = await storage.pipelineRuns.list({ projectId: "project", statuses: ["queued"] })
    const executions = await Promise.all(
      runs.map((run) => storage.executions.getById({ projectId: "project", id: run.executionId }))
    )
    return executions.flatMap((execution) =>
      execution?.source.type === "datasetVersion" ? [execution.source.versionId] : []
    )
  }

  test("recovers a commit whose event was lost, through the lake's change feed", async () => {
    const first = await commit([{ id: "order-1", value: "a" }])
    await runThatRead(first)
    const pass = triggersPass()
    await pass.run(signal)
    expect(await recoveredVersions()).toEqual([])

    const second = await commit([{ id: "order-2", value: "b" }])
    letTheEventBeLost()
    await pass.run(signal)

    expect(await recoveredVersions()).toEqual([second])
  })

  test("a restart finds what was committed while no orchestrator ran", async () => {
    const first = await commit([{ id: "order-1", value: "a" }])
    await runThatRead(first)
    const second = await commit([{ id: "order-2", value: "b" }])

    letTheEventBeLost()
    await triggersPass().run(signal)

    expect(await recoveredVersions()).toEqual([second])
  })

  test("identical rows are no change, and hide no change under them", async () => {
    const first = await commit([{ id: "order-1", value: "a" }])
    await runThatRead(first)
    const changed = await commit([{ id: "order-1", value: "b" }])
    await commit([{ id: "order-1", value: "b" }])

    letTheEventBeLost()
    await triggersPass().run(signal)

    expect(await recoveredVersions()).toEqual([changed])
  })

  test("a run that read identical rows on top of the change has read the change", async () => {
    await commit([{ id: "order-1", value: "a" }])
    await commit([{ id: "order-1", value: "b" }])
    const noOp = await commit([{ id: "order-1", value: "b" }])
    await runThatRead(noOp)

    letTheEventBeLost()
    await triggersPass().run(signal)

    expect(await recoveredVersions()).toEqual([])
  })

  test("a schema-only version is no change", async () => {
    const version = await commit([{ id: "order-1", value: "a" }])
    await runThatRead(version)
    await lake.createDataset(ordersWithNote)

    letTheEventBeLost()
    await triggersPass().run(signal)

    expect((await lake.getLatestVersion(orders.id))?.mode).toBe("schema")
    expect(await recoveredVersions()).toEqual([])
  })

  test("an idle pass reads the catalog's change feed and nothing else", async () => {
    const version = await commit([{ id: "order-1", value: "a" }])
    await runThatRead(version)
    const pass = triggersPass()
    await pass.run(signal)
    letTheEventBeLost()
    await pass.run(signal)

    const feed = spyOn(lake, "listLatestVersionsSince")
    const latest = spyOn(lake, "getLatestVersion")
    letTheEventBeLost()
    await pass.run(signal)

    expect(feed).toHaveBeenCalledTimes(1)
    expect(latest).not.toHaveBeenCalled()
  })
})
