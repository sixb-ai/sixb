import { describe, expect, test } from "bun:test"
import type { SixbHostView } from "@sixb/core"
import { col, defineDataset, definePipeline, definePipelineStep } from "@sixb/core"
import type {
  ListLatestPipelineRunsInput,
  PipelineRunFailureCode,
  PipelineRunStorage,
  SixbFailure,
} from "@sixb/core/storage"
import { Elysia } from "elysia"
import { registerPipelineRoutes } from "../src/routes/pipelines"

const rawDataset = defineDataset("raw.customers", {
  schema: [col("id", "string")],
})

const cleanDataset = defineDataset("clean.customers", {
  schema: [col("id", "string")],
})

const cleanStep = definePipelineStep("clean-customers")
  .inputs({ raw: rawDataset })
  .output(cleanDataset)
  .run(async () => {})

const pipeline = definePipeline("customers").then(cleanStep)

const FAILURE: SixbFailure<PipelineRunFailureCode> = {
  code: "internal.unexpected",
  message: "Pipeline failed",
  retryable: false,
  at: "2026-05-08T10:00:01.000Z",
  details: { pipelineId: "customers" },
}

const CANCELLED_FAILURE: SixbFailure<PipelineRunFailureCode> = {
  ...FAILURE,
  code: "runtime.cancelled",
  message: "Step cancelled",
}

function createSixbStub(pipelineRuns: Partial<PipelineRunStorage>): SixbHostView {
  return {
    id: "my-app",
    storage: { pipelineRuns },
    definitions: {
      pipelines: {
        list: () => [pipeline],
        getById: (id: string) => (id === pipeline.id ? pipeline : null),
      },
    },
  } as unknown as SixbHostView
}

function createTestApp(pipelineRuns: Partial<PipelineRunStorage>) {
  const host = createSixbStub(pipelineRuns)
  const sixbExecution = {
    pipelines: {
      list: () => host.definitions.pipelines.list(),
      getById: (pipelineId: string) => host.definitions.pipelines.getById(pipelineId),
      runs: {
        async getById(runId: string) {
          return (await pipelineRuns.getById?.({ projectId: host.id, id: runId })) ?? null
        },
        async listLatest(pipelineIds: readonly string[]) {
          return (
            (await pipelineRuns.listLatestByPipelineIds?.({
              projectId: host.id,
              pipelineIds,
            })) ?? { runs: [] }
          )
        },
        async listSteps(pipelineRunId: string, input: { readonly order?: "asc" | "desc" } = {}) {
          return (
            (await pipelineRuns.listSteps?.({
              projectId: host.id,
              pipelineRunId,
              ...input,
            })) ?? null
          )
        },
      },
    },
  }
  const app = new Elysia()
  app.derive(() => ({ sixb: sixbExecution }))

  return registerPipelineRoutes(app, host)
}

describe("pipeline routes", () => {
  test("list route exposes the specialized latest-run failure", async () => {
    let bulkCalls = 0
    const requestedPipelineIds: string[][] = []
    const app = createTestApp({
      async listLatestByPipelineIds(input: ListLatestPipelineRunsInput) {
        bulkCalls += 1
        requestedPipelineIds.push([...input.pipelineIds])
        return {
          runs: [
            {
              id: "run-customers",
              projectId: "my-app",
              executionId: "exec-run-customers",
              pipelineId: "customers",
              status: "failed",
              queuedAt: new Date("2026-05-08T09:59:59.000Z"),
              startedAt: new Date("2026-05-08T10:00:00.000Z"),
              finishedAt: new Date("2026-05-08T10:00:01.000Z"),
              error: FAILURE,
            },
          ],
        }
      },
    })

    const response = await app.handle(new Request("http://localhost/api/pipelines"))
    expect(response.status).toBe(200)
    expect(bulkCalls).toBe(1)
    expect(requestedPipelineIds).toEqual([["customers"]])
    expect(await response.json()).toMatchObject([
      {
        id: "customers",
        latestRun: { status: "failed", error: FAILURE },
      },
    ])
  })

  test("detail route exposes the same failure contract for runs and steps", async () => {
    const app = createTestApp({
      async getById() {
        return {
          id: "run-customers",
          projectId: "my-app",
          executionId: "exec-run-customers",
          pipelineId: "customers",
          status: "failed",
          queuedAt: new Date("2026-05-08T09:59:59.000Z"),
          startedAt: new Date("2026-05-08T10:00:00.000Z"),
          finishedAt: new Date("2026-05-08T10:00:01.000Z"),
          error: FAILURE,
        }
      },
      async listSteps() {
        return {
          steps: [
            {
              id: "step-run-clean",
              projectId: "my-app",
              pipelineRunId: "run-customers",
              pipelineId: "customers",
              stepId: "clean-customers",
              datasetId: "clean.customers",
              mode: "snapshot",
              status: "cancelled",
              startedAt: new Date("2026-05-08T10:00:00.100Z"),
              finishedAt: new Date("2026-05-08T10:00:00.900Z"),
              inputs: [{ datasetId: "raw.customers", versionId: "ver-raw" }],
              error: CANCELLED_FAILURE,
            },
          ],
          hasMore: false,
          total: 1,
        }
      },
    })

    const response = await app.handle(
      new Request("http://localhost/api/pipeline-runs/run-customers")
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      run: { status: "failed", error: FAILURE },
      steps: [{ status: "cancelled", error: CANCELLED_FAILURE }],
    })
  })
})
