import { describe, expect, test } from "bun:test"
import type { OntologySource, Sixb } from "@sixb/core"
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
  causeChain: [{ name: "Error", message: "root cause" }],
}

const CANCELLED_FAILURE: SixbFailure<PipelineRunFailureCode> = {
  ...FAILURE,
  code: "runtime.cancelled",
  message: "Step cancelled",
}

function createSixbStub(
  pipelineRuns: Partial<PipelineRunStorage>
): Sixb<readonly OntologySource[]> {
  return {
    id: "my-app",
    storage: { pipelineRuns },
    listPipelines: () => [pipeline],
    getPipelineById: (id: string) => (id === pipeline.id ? pipeline : null),
  } as unknown as Sixb<readonly OntologySource[]>
}

describe("pipeline routes", () => {
  test("list route exposes the specialized latest-run failure", async () => {
    let bulkCalls = 0
    const requestedPipelineIds: string[][] = []
    const app = registerPipelineRoutes(
      new Elysia(),
      createSixbStub({
        async listLatestByPipelineIds(input: ListLatestPipelineRunsInput) {
          bulkCalls += 1
          requestedPipelineIds.push([...input.pipelineIds])
          return {
            runs: [
              {
                id: "run-customers",
                projectId: "my-app",
                pipelineId: "customers",
                status: "failed",
                startedAt: new Date("2026-05-08T10:00:00.000Z"),
                finishedAt: new Date("2026-05-08T10:00:01.000Z"),
                error: FAILURE,
              },
            ],
          }
        },
      })
    )

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
    const app = registerPipelineRoutes(
      new Elysia(),
      createSixbStub({
        async getById() {
          return {
            id: "run-customers",
            projectId: "my-app",
            pipelineId: "customers",
            status: "failed",
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
    )

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
