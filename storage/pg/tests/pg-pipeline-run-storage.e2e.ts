import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { PipelineRunError } from "@sixb/core"
import type { PostgresStorage } from "../src"
import { PgPipelineRunStorage } from "../src"
import { createTestStorage } from "./helpers"

describe("PgPipelineRunStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("starts and finishes pipeline runs", async () => {
    await storage.pipelineRuns.start({
      id: "run-1",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })

    const finished = await storage.pipelineRuns.finish({
      id: "run-1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-05-08T10:00:04.500Z"),
      output: {
        datasetId: "insights.customers",
        versionId: "ver_final",
      },
    })

    const stored = await storage.pipelineRuns.getById({
      projectId: "my-app",
      id: "run-1",
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.output).toEqual({
      datasetId: "insights.customers",
      versionId: "ver_final",
    })
    expect(stored?.startedAt.toISOString()).toBe("2026-05-08T10:00:00.000Z")
    expect(stored?.finishedAt?.toISOString()).toBe("2026-05-08T10:00:04.500Z")
  })

  test("stores failures and supports filtered pipeline run paging", async () => {
    await storage.pipelineRuns.start({
      id: "run-1",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })
    await storage.pipelineRuns.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      error: {
        name: "Error",
        message: "No committed source version",
      },
    })

    await storage.pipelineRuns.start({
      id: "run-2",
      projectId: "my-app",
      pipelineId: "customers",
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.pipelineRuns.finish({
      id: "run-2",
      projectId: "my-app",
      status: "succeeded",
      output: {
        datasetId: "insights.customers",
        versionId: "ver_2",
      },
    })

    await storage.pipelineRuns.start({
      id: "run-3",
      projectId: "my-app",
      pipelineId: "orders",
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const page = await storage.pipelineRuns.list({
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

    const empty = await storage.pipelineRuns.list({
      projectId: "my-app",
      statuses: [],
    })
    expect(empty).toEqual({
      runs: [],
      hasMore: false,
      total: 0,
    })

    const failed = await storage.pipelineRuns.getById({
      projectId: "my-app",
      id: "run-1",
    })
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toEqual({
      name: "Error",
      message: "No committed source version",
    })
  })

  test("starts and finishes step runs with pinned inputs", async () => {
    await storage.pipelineRuns.start({
      id: "piperun_1",
      projectId: "my-app",
      pipelineId: "customers",
    })

    const started = await storage.pipelineRuns.startStep({
      id: "step_1",
      projectId: "my-app",
      pipelineRunId: "piperun_1",
      pipelineId: "customers",
      stepId: "clean-customers",
      datasetId: "canonical.customers",
      mode: "snapshot",
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
      inputs: [
        {
          datasetId: "raw.customers",
          versionId: "ver_raw_1",
        },
      ],
    })

    ;(started.inputs as { datasetId: string; versionId: string }[])[0]!.versionId = "mutated"

    const finished = await storage.pipelineRuns.finishStep({
      id: "step_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-05-08T10:00:01.200Z"),
      rowsWritten: 42,
      output: {
        datasetId: "canonical.customers",
        versionId: "ver_clean_1",
      },
    })

    const steps = await storage.pipelineRuns.listSteps({
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

  test("stores failed step runs and supports filtered paging", async () => {
    await storage.pipelineRuns.start({
      id: "piperun_1",
      projectId: "my-app",
      pipelineId: "customers",
    })

    await storage.pipelineRuns.startStep({
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
    await storage.pipelineRuns.finishStep({
      id: "step-1",
      projectId: "my-app",
      status: "failed",
      rowsWritten: 3,
      error: {
        name: "Error",
        message: "Invalid row",
      },
    })

    await storage.pipelineRuns.startStep({
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
    await storage.pipelineRuns.finishStep({
      id: "step-2",
      projectId: "my-app",
      status: "succeeded",
      output: {
        datasetId: "canonical.orders",
        versionId: "ver_orders_1",
      },
    })

    await storage.pipelineRuns.startStep({
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

    const page = await storage.pipelineRuns.listSteps({
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

    const failedSteps = await storage.pipelineRuns.listSteps({
      projectId: "my-app",
      statuses: ["failed"],
    })
    expect(failedSteps.steps[0]?.error).toEqual({
      name: "Error",
      message: "Invalid row",
    })
    expect(failedSteps.steps[0]?.rowsWritten).toBe(3)
  })

  test("rejects duplicates, missing records, terminal rewrites, and mismatched outputs", async () => {
    await storage.pipelineRuns.start({
      id: "piperun_1",
      projectId: "my-app",
      pipelineId: "customers",
    })

    await expect(
      storage.pipelineRuns.start({
        id: "piperun_1",
        projectId: "my-app",
        pipelineId: "customers",
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await expect(
      storage.pipelineRuns.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: {
          message: "boom",
        },
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await storage.pipelineRuns.startStep({
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
      storage.pipelineRuns.finishStep({
        id: "step_1",
        projectId: "my-app",
        status: "succeeded",
        output: {
          datasetId: "wrong.customers",
          versionId: "ver_wrong",
        },
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await storage.pipelineRuns.finishStep({
      id: "step_1",
      projectId: "my-app",
      status: "cancelled",
      error: {
        message: "Stopped",
      },
    })

    await expect(
      storage.pipelineRuns.finishStep({
        id: "step_1",
        projectId: "my-app",
        status: "failed",
        error: {
          message: "Too late",
        },
      })
    ).rejects.toBeInstanceOf(PipelineRunError)

    await storage.pipelineRuns.finish({
      id: "piperun_1",
      projectId: "my-app",
      status: "cancelled",
      error: {
        message: "Stopped",
      },
    })

    await expect(
      storage.pipelineRuns.startStep({
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
  })

  test("PostgresStorage includes pipeline run storage", () => {
    expect(storage.pipelineRuns).toBeInstanceOf(PgPipelineRunStorage)
  })
})
