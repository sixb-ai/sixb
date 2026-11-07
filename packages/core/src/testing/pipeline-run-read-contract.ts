import { describe, expect, test } from "bun:test"
import type { PipelineRunStorage, Storage } from "../storage"
import { queueTestPipelineRun, startTestPipelineRun } from "./pipeline-execution"

type PipelineRunReadStorage = Pick<Storage, "executions"> & {
  readonly pipelineRuns: PipelineRunStorage
}

export interface PipelineRunReadContractSuiteOptions<TStorage extends PipelineRunReadStorage> {
  /** Returns isolated storage for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "pipeline-run-read-contract"
const hour = 60 * 60 * 1000
const startedAt = new Date("2026-11-07T08:00:00.000Z")

/** The reads that answer, for many pipelines at once, what each one last read. */
export function runPipelineRunReadContractSuite<TStorage extends PipelineRunReadStorage>(
  label: string,
  options: PipelineRunReadContractSuiteOptions<TStorage>
): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  async function finishedRun(
    storage: TStorage,
    id: string,
    pipelineId: string,
    status: "succeeded" | "cancelled",
    hoursIn: number
  ): Promise<void> {
    await startTestPipelineRun(storage, {
      id,
      projectId,
      pipelineId,
      startedAt: new Date(startedAt.getTime() + hoursIn * hour),
    })
    await storage.pipelineRuns.finish({ id, projectId, status })
  }

  async function stepOf(storage: TStorage, runId: string, stepId: string): Promise<void> {
    await startTestPipelineRun(storage, { id: runId, projectId, pipelineId: "orders" })
    await storage.pipelineRuns.startStep({
      id: `${runId}:${stepId}`,
      projectId,
      pipelineRunId: runId,
      pipelineId: "orders",
      stepId,
      datasetId: "orders.clean",
      mode: "snapshot",
      inputs: [{ datasetId: "orders.raw", versionId: `read-by-${runId}` }],
    })
  }

  describe(`${label} pipeline run reads`, () => {
    test("the latest run per pipeline can leave a status out", () =>
      withStorage(async (storage) => {
        await finishedRun(storage, "orders-1", "orders", "succeeded", 0)
        await finishedRun(storage, "orders-2", "orders", "cancelled", 1)
        await finishedRun(storage, "customers-1", "customers", "cancelled", 0)
        const pipelineIds = ["orders", "customers"]

        const latest = await storage.pipelineRuns.listLatestByPipelineIds({
          projectId,
          pipelineIds,
        })
        const counted = await storage.pipelineRuns.listLatestByPipelineIds({
          projectId,
          pipelineIds,
          excludedStatus: "cancelled",
        })

        expect(latest.runs.map((run) => run.id)).toEqual(["orders-2", "customers-1"])
        expect(counted.runs.map((run) => run.id)).toEqual(["orders-1"])
      }))

    test("steps can be read for several runs at once, and for none", () =>
      withStorage(async (storage) => {
        await stepOf(storage, "run-1", "clean")
        await stepOf(storage, "run-2", "clean")
        await stepOf(storage, "run-3", "clean")

        const { steps } = await storage.pipelineRuns.listSteps({
          projectId,
          pipelineRunIds: ["run-1", "run-3"],
        })
        const none = await storage.pipelineRuns.listSteps({ projectId, pipelineRunIds: [] })

        expect(steps.map((step) => step.pipelineRunId).sort()).toEqual(["run-1", "run-3"])
        expect(steps[0]?.inputs).toHaveLength(1)
        expect(none.steps).toEqual([])
      }))

    test("a queued run has no step, and keeps a project's reads to itself", () =>
      withStorage(async (storage) => {
        await queueTestPipelineRun(storage, {
          id: "queued",
          projectId,
          pipelineId: "orders",
        })

        const elsewhere = await storage.pipelineRuns.listLatestByPipelineIds({
          projectId: `${projectId}-other`,
          pipelineIds: ["orders"],
        })
        const { steps } = await storage.pipelineRuns.listSteps({
          projectId,
          pipelineRunIds: ["queued"],
        })

        expect(elsewhere.runs).toEqual([])
        expect(steps).toEqual([])
      }))
  })
}
