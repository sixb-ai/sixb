import { describe, expect, test } from "bun:test"
import type { OntologySource, Sixb } from "@sixb/core"
import { defineWorkflow, defineWorkflowStep } from "@sixb/core"
import type {
  ListLatestWorkflowRunsInput,
  SixbFailure,
  WorkflowNodeRunStorage,
  WorkflowRunFailureCode,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { Elysia } from "elysia"
import { registerWorkflowRoutes } from "../src/routes/workflows"

const step = defineWorkflowStep("review")
  .input({})
  .output({})
  .run(() => ({}))

const workflow = defineWorkflow("review-request").input({}).then(step)

const FAILURE: SixbFailure<WorkflowRunFailureCode> = {
  code: "internal.unexpected",
  message: "Workflow failed",
  retryable: false,
  at: "2026-05-08T10:00:01.000Z",
  details: { workflowId: workflow.id, runId: "run-review" },
  causeChain: [{ name: "Error", message: "root cause" }],
}

const CANCELLED_FAILURE: SixbFailure<WorkflowRunFailureCode> = {
  ...FAILURE,
  code: "runtime.cancelled",
  message: "Node cancelled",
  details: {
    workflowId: workflow.id,
    workflowRunId: "run-review",
    nodeRunId: "run-review:node:0",
  },
}

type WorkflowRunStorageStub = Partial<Omit<WorkflowRunStorage, "nodes">> & {
  readonly nodes?: Partial<WorkflowNodeRunStorage>
}

function createSixbStub(workflowRuns: WorkflowRunStorageStub): Sixb<readonly OntologySource[]> {
  return {
    id: "my-app",
    storage: { workflowRuns },
    workflows: {
      list: () => [workflow],
      getById: (id: string) => (id === workflow.id ? workflow : null),
    },
  } as unknown as Sixb<readonly OntologySource[]>
}

describe("workflow routes", () => {
  test("list route exposes the specialized latest-run failure", async () => {
    let bulkCalls = 0
    const app = registerWorkflowRoutes(
      new Elysia(),
      createSixbStub({
        async listLatestByWorkflowIds(input: ListLatestWorkflowRunsInput) {
          bulkCalls += 1
          expect(input.workflowIds).toEqual([workflow.id])
          return {
            runs: [
              {
                id: "run-review",
                projectId: "my-app",
                workflowId: workflow.id,
                status: "failed",
                input: {},
                startedAt: new Date("2026-05-08T10:00:00.000Z"),
                finishedAt: new Date("2026-05-08T10:00:01.000Z"),
                error: FAILURE,
                requestedByPrincipal: { type: "system", id: "system" },
                attempt: 1,
              },
            ],
          }
        },
      })
    )

    const response = await app.handle(new Request("http://localhost/api/workflows"))
    expect(response.status).toBe(200)
    expect(bulkCalls).toBe(1)
    expect(await response.json()).toMatchObject([
      { id: workflow.id, latestRun: { status: "failed", error: FAILURE } },
    ])
  })

  test("detail route exposes the same failure contract for runs and nodes", async () => {
    const app = registerWorkflowRoutes(
      new Elysia(),
      createSixbStub({
        async getById() {
          return {
            id: "run-review",
            projectId: "my-app",
            workflowId: workflow.id,
            status: "failed",
            input: {},
            startedAt: new Date("2026-05-08T10:00:00.000Z"),
            finishedAt: new Date("2026-05-08T10:00:01.000Z"),
            error: FAILURE,
            requestedByPrincipal: { type: "system", id: "system" },
            attempt: 1,
          }
        },
        nodes: {
          async list() {
            return {
              nodes: [
                {
                  id: "run-review:node:0",
                  projectId: "my-app",
                  workflowRunId: "run-review",
                  workflowId: workflow.id,
                  nodeIndex: 0,
                  nodeType: "step",
                  nodeId: step.id,
                  nodeKey: step.id,
                  status: "cancelled",
                  input: {},
                  startedAt: new Date("2026-05-08T10:00:00.100Z"),
                  finishedAt: new Date("2026-05-08T10:00:00.900Z"),
                  error: CANCELLED_FAILURE,
                },
              ],
              hasMore: false,
              total: 1,
            }
          },
        },
      })
    )

    const response = await app.handle(new Request("http://localhost/api/workflow-runs/run-review"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      run: { status: "failed", error: FAILURE },
      nodes: [{ status: "cancelled", error: CANCELLED_FAILURE }],
    })
  })
})
