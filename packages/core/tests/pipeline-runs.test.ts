import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import type { PipelineRunFailureCode, SixbFailure } from "../src/storage"
import { InMemoryPipelineRunStorage, PipelineRunError } from "../src/storage"

const FAILURE: SixbFailure<PipelineRunFailureCode> = {
  code: "internal.unexpected",
  message: "Pipeline failed",
  retryable: false,
  at: "2026-05-08T10:00:01.000Z",
  details: { pipelineId: "customers" },
  causeChain: [{ name: "Error", message: "root cause" }],
}

const CANCELLED_FAILURE: SixbFailure<PipelineRunFailureCode> = {
  ...FAILURE,
  code: "runtime.cancelled",
  message: "Stopped",
}

describe("InMemoryPipelineRunStorage", () => {
  test("starts and finishes a successful pipeline run", async () => {
    const storage = new InMemoryPipelineRunStorage()
    const startedAt = new Date("2026-05-08T10:00:00.000Z")
    const finishedAt = new Date("2026-05-08T10:00:04.500Z")

    const started = await storage.start({
      id: "piperun_1",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt,
    })

    started.startedAt.setUTCFullYear(2040)

    const finished = await storage.finish({
      id: "piperun_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt,
      output: {
        datasetId: "insights.customers",
        versionId: "ver_final",
      },
    })

    const stored = await storage.getById({
      projectId: "my-app",
      id: "piperun_1",
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.output).toEqual({
      datasetId: "insights.customers",
      versionId: "ver_final",
    })
    expect(stored?.startedAt.toISOString()).toBe(startedAt.toISOString())
    expect(stored?.finishedAt?.toISOString()).toBe(finishedAt.toISOString())
  })

  test("stores failed pipeline runs and lists with filters, ordering, and paging", async () => {
    const storage = new InMemoryPipelineRunStorage()

    await storage.start({
      id: "run-1",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })
    await storage.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      finishedAt: new Date("2026-05-08T10:00:01.000Z"),
      error: { ...FAILURE, message: "No committed source version" },
    })

    await storage.start({
      id: "run-2",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.finish({
      id: "run-2",
      projectId: "my-app",
      status: "succeeded",
      output: {
        datasetId: "insights.customers",
        versionId: "ver_2",
      },
    })

    await storage.start({
      id: "run-3",
      projectId: "my-app",
      pipelineId: "orders",
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const page = await storage.list({
      projectId: "my-app",
      pipelineId: "customers",
      statuses: ["running", "succeeded"],
      startedAfter: new Date("2026-05-08T10:30:00.000Z"),
      limit: 1,
      offset: 0,
    })

    expect(page.total).toBe(1)
    expect(page.hasMore).toBe(false)
    expect(page.runs.map((run) => run.id)).toEqual(["run-2"])

    const selectedPipelines = await storage.list({
      projectId: "my-app",
      pipelineIds: ["orders"],
    })
    expect(selectedPipelines.total).toBe(1)
    expect(selectedPipelines.runs.map((run) => run.id)).toEqual(["run-3"])

    // An empty allowlist must deny all — never fall through to an unfiltered list.
    const noneAllowed = await storage.list({ projectId: "my-app", pipelineIds: [] })
    expect(noneAllowed).toEqual({ runs: [], hasMore: false, total: 0 })

    const empty = await storage.list({
      projectId: "my-app",
      statuses: [],
    })
    expect(empty).toEqual({
      runs: [],
      hasMore: false,
      total: 0,
    })

    const failed = await storage.getById({
      projectId: "my-app",
      id: "run-1",
    })
    expect(failed?.status).toBe("failed")
    expect(failed?.output).toBeUndefined()
    expect(failed?.error).toEqual({ ...FAILURE, message: "No committed source version" })
  })

  test("lists the latest run for multiple pipeline ids", async () => {
    const storage = new InMemoryPipelineRunStorage()

    await storage.start({
      id: "run-customers-a",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.start({
      id: "run-customers-z",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.start({
      id: "run-orders",
      projectId: "my-app",
      pipelineId: "orders",
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })
    await storage.start({
      id: "run-other-project",
      projectId: "other-app",
      pipelineId: "customers",
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const latest = await storage.listLatestByPipelineIds({
      projectId: "my-app",
      pipelineIds: ["orders", "missing", "customers", "customers"],
    })

    expect(latest.runs.map((run) => run.id)).toEqual(["run-orders", "run-customers-z"])
  })

  test("starts and finishes step runs with pinned inputs", async () => {
    const storage = new InMemoryPipelineRunStorage()
    const startedAt = new Date("2026-05-08T10:00:00.000Z")
    const finishedAt = new Date("2026-05-08T10:00:01.200Z")

    await storage.start({
      id: "piperun_1",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt,
    })

    const started = await storage.startStep({
      id: "step_1",
      projectId: "my-app",
      pipelineRunId: "piperun_1",
      pipelineId: "customers",
      stepId: "clean-customers",
      datasetId: "canonical.customers",
      mode: "snapshot",
      startedAt,
      inputs: [
        {
          datasetId: "raw.customers",
          versionId: "ver_raw_1",
        },
      ],
    })

    ;(started.inputs as { datasetId: string; versionId: string }[])[0]!.versionId = "mutated"

    const finished = await storage.finishStep({
      id: "step_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt,
      rowsWritten: 42,
      output: {
        datasetId: "canonical.customers",
        versionId: "ver_clean_1",
      },
    })

    const steps = await storage.listSteps({
      projectId: "my-app",
      pipelineRunId: "piperun_1",
    })

    expect(finished).toMatchObject({
      status: "succeeded",
      rowsWritten: 42,
      output: {
        datasetId: "canonical.customers",
        versionId: "ver_clean_1",
      },
    })
    expect(finished.inputs).toEqual([
      {
        datasetId: "raw.customers",
        versionId: "ver_raw_1",
      },
    ])
    expect(steps.total).toBe(1)
    expect(steps.steps.map((step) => step.id)).toEqual(["step_1"])
  })

  test("stores failed step runs and lists with filters, ordering, and paging", async () => {
    const storage = new InMemoryPipelineRunStorage()

    await storage.start({
      id: "piperun_1",
      projectId: "my-app",
      pipelineId: "customers",
    })

    await storage.startStep({
      id: "step-1",
      projectId: "my-app",
      pipelineRunId: "piperun_1",
      pipelineId: "customers",
      stepId: "clean-customers",
      datasetId: "canonical.customers",
      mode: "snapshot",
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
      inputs: [],
    })
    await storage.finishStep({
      id: "step-1",
      projectId: "my-app",
      status: "failed",
      rowsWritten: 3,
      error: { ...FAILURE, message: "Invalid row" },
    })

    await storage.startStep({
      id: "step-2",
      projectId: "my-app",
      pipelineRunId: "piperun_1",
      pipelineId: "customers",
      stepId: "normalize-orders",
      datasetId: "canonical.orders",
      mode: "append",
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
      inputs: [],
    })
    await storage.finishStep({
      id: "step-2",
      projectId: "my-app",
      status: "succeeded",
      output: {
        datasetId: "canonical.orders",
        versionId: "ver_orders_1",
      },
    })

    await storage.startStep({
      id: "step-3",
      projectId: "my-app",
      pipelineRunId: "piperun_1",
      pipelineId: "customers",
      stepId: "customer-insights",
      datasetId: "insights.customers",
      mode: "snapshot",
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
      inputs: [],
    })

    const page = await storage.listSteps({
      projectId: "my-app",
      pipelineId: "customers",
      statuses: ["running", "succeeded"],
      startedAfter: new Date("2026-05-08T10:30:00.000Z"),
      limit: 1,
      offset: 1,
    })

    expect(page.total).toBe(2)
    expect(page.hasMore).toBe(false)
    expect(page.steps.map((step) => step.id)).toEqual(["step-2"])

    const failedSteps = await storage.listSteps({
      projectId: "my-app",
      statuses: ["failed"],
    })
    expect(failedSteps.steps[0]?.error).toEqual({ ...FAILURE, message: "Invalid row" })
    expect(failedSteps.steps[0]?.rowsWritten).toBe(3)
  })

  test("rejects duplicate starts, missing finishes, terminal rewrites, and mismatched outputs", async () => {
    const storage = new InMemoryPipelineRunStorage()

    await storage.start({
      id: "piperun_1",
      projectId: "my-app",
      pipelineId: "customers",
    })

    await expect(
      storage.start({
        id: "piperun_1",
        projectId: "my-app",
        pipelineId: "customers",
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await expect(
      storage.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: { ...FAILURE, message: "boom" },
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await storage.startStep({
      id: "step_1",
      projectId: "my-app",
      pipelineRunId: "piperun_1",
      pipelineId: "customers",
      stepId: "clean-customers",
      datasetId: "canonical.customers",
      mode: "snapshot",
      inputs: [],
    })

    await expect(
      storage.finishStep({
        id: "step_1",
        projectId: "my-app",
        status: "succeeded",
        output: {
          datasetId: "wrong.customers",
          versionId: "ver_wrong",
        },
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await storage.finishStep({
      id: "step_1",
      projectId: "my-app",
      status: "cancelled",
      error: CANCELLED_FAILURE,
    })

    await expect(
      storage.finishStep({
        id: "step_1",
        projectId: "my-app",
        status: "failed",
        error: { ...FAILURE, message: "Too late" },
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await storage.finish({
      id: "piperun_1",
      projectId: "my-app",
      status: "cancelled",
      error: CANCELLED_FAILURE,
    })

    await expect(
      storage.startStep({
        id: "step_2",
        projectId: "my-app",
        pipelineRunId: "piperun_1",
        pipelineId: "customers",
        stepId: "too-late",
        datasetId: "canonical.customers",
        mode: "snapshot",
        inputs: [],
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await expect(
      storage.finish({
        id: "piperun_1",
        projectId: "my-app",
        status: "failed",
        error: { ...FAILURE, message: "Too late" },
      })
    ).rejects.toBeInstanceOf(PipelineRunError)
  })

  test("InMemoryStorage includes pipeline run storage", () => {
    const storage = new InMemoryStorage()
    expect(storage.pipelineRuns).toBeInstanceOf(InMemoryPipelineRunStorage)
  })
})
