import { randomUUID } from "node:crypto"
import type {
  OntologySource,
  Pario,
  WorkflowDefinition,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
} from "@pario/core"
import { snapshotWorkflowInput } from "@pario/core"
import type { Elysia } from "elysia"
import { PARIO_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { ErrorResponseSchema } from "../schemas/common"
import {
  RequestWorkflowRunBodySchema,
  RequestWorkflowRunResponseSchema,
  WorkflowParamsSchema,
  WorkflowRunDetailResponseSchema,
  WorkflowRunListResponseSchema,
  WorkflowRunParamsSchema,
  WorkflowRunsQuerySchema,
  WorkflowSchema,
} from "../schemas/workflows"
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

function serializeWorkflowRun(run: WorkflowRunRecord) {
  return {
    id: run.id,
    projectId: run.projectId,
    workflowId: run.workflowId,
    status: run.status,
    input: run.input,
    queuedAt: run.queuedAt ? toIsoString(run.queuedAt) : undefined,
    startedAt: toIsoString(run.startedAt),
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    error: run.error,
  }
}

function serializeWorkflowNodeRun(node: WorkflowNodeRunRecord) {
  return {
    id: node.id,
    projectId: node.projectId,
    workflowRunId: node.workflowRunId,
    workflowId: node.workflowId,
    nodeIndex: node.nodeIndex,
    nodeType: node.nodeType,
    nodeId: node.nodeId,
    nodeKey: node.nodeKey,
    status: node.status,
    input: node.input,
    startedAt: toIsoString(node.startedAt),
    finishedAt: node.finishedAt ? toIsoString(node.finishedAt) : undefined,
    output: node.output,
    error: node.error,
  }
}

async function getLatestWorkflowRun(
  pario: Pario<readonly OntologySource[]>,
  workflowId: string
): Promise<ReturnType<typeof serializeWorkflowRun> | null> {
  if (!pario.storage.workflowRuns) {
    return null
  }

  const result = await pario.storage.workflowRuns.list({
    projectId: pario.id,
    workflowId,
    limit: 1,
    order: "desc",
  })

  const [latest] = result.runs
  return latest ? serializeWorkflowRun(latest) : null
}

async function serializeWorkflow(
  pario: Pario<readonly OntologySource[]>,
  workflow: WorkflowDefinition
): Promise<ReturnType<typeof WorkflowSchema.parse>> {
  return WorkflowSchema.parse({
    id: workflow.id,
    input: workflow.input,
    triggers: workflow.triggers,
    nodes: workflow.nodes.map((node) => {
      if (node.type === "step") {
        return {
          type: "step" as const,
          id: node.id,
          key: node.key,
          input: node.step.input,
          output: node.step.output,
        }
      }

      return {
        type: "action" as const,
        id: node.id,
        key: node.key,
        targetObjectTypeId: node.action.target.id,
        params: node.action.params,
      }
    }),
    latestRun: await getLatestWorkflowRun(pario, workflow.id),
  })
}

export function registerWorkflowRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app
    .get(
      "/api/workflows",
      async () => {
        return await Promise.all(
          pario.getWorkflowDefinitions().map((workflow) => serializeWorkflow(pario, workflow))
        )
      },
      {
        response: { 200: WorkflowSchema.array() },
        detail: {
          summary: "List registered workflows",
          tags: ["Workflows"],
          operationId: "listWorkflows",
        },
      }
    )
    .get(
      "/api/workflows/:workflowId",
      async ({ params, set }) => {
        const workflow = pario.getWorkflowById(params.workflowId)
        if (!workflow) {
          set.status = 404
          return { error: "Workflow not found" }
        }

        return await serializeWorkflow(pario, workflow)
      },
      {
        params: WorkflowParamsSchema,
        response: { 200: WorkflowSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get workflow metadata",
          tags: ["Workflows"],
          operationId: "getWorkflow",
        },
      }
    )
    .get(
      "/api/workflow-runs",
      async ({ query, set }) => {
        try {
          const parsed = WorkflowRunsQuerySchema.parse(query)
          const storage = pario.storage.workflowRuns
          if (!storage) {
            return { runs: [], hasMore: false, total: 0 }
          }

          const result = await storage.list({
            projectId: pario.id,
            workflowId: parsed.workflowId,
            statuses: parsed.status ? [parsed.status] : undefined,
            startedAfter: parseDate(parsed.startedAfter),
            startedBefore: parseDate(parsed.startedBefore),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })

          return {
            runs: result.runs.map(serializeWorkflowRun),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: WorkflowRunsQuerySchema,
        response: { 200: WorkflowRunListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List workflow run history",
          tags: ["Workflows"],
          operationId: "listWorkflowRuns",
        },
      }
    )
    .get(
      "/api/workflow-runs/:runId",
      async ({ params, set }) => {
        try {
          const storage = pario.storage.workflowRuns
          if (!storage) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }

          const run = await storage.getById({ projectId: pario.id, id: params.runId })
          if (!run) {
            set.status = 404
            return { error: "Workflow run not found" }
          }

          const nodes = await storage.nodes.list({
            projectId: pario.id,
            workflowRunId: run.id,
            order: "asc",
          })

          return WorkflowRunDetailResponseSchema.parse({
            run: serializeWorkflowRun(run),
            nodes: nodes.nodes.map(serializeWorkflowNodeRun),
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: WorkflowRunParamsSchema,
        response: {
          200: WorkflowRunDetailResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get workflow run detail",
          tags: ["Workflows"],
          operationId: "getWorkflowRun",
        },
      }
    )
    .post(
      "/api/workflows/:workflowId/runs",
      async ({ params, body, set }) => {
        try {
          const workflow = pario.getWorkflowById(params.workflowId)
          if (!workflow) {
            set.status = 404
            return { error: "Workflow not found" }
          }

          const storage = pario.storage.workflowRuns
          if (!storage) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }

          const parsedBody = RequestWorkflowRunBodySchema.parse(body)
          const input = parsedBody.input ?? {}
          const snapshot = snapshotWorkflowInput({
            workflow,
            value: input,
            valueTypesById: pario.ontology.getValueTypesById(),
          })
          const runId = `run_${randomUUID()}`
          const queuedAt = new Date()

          await storage.queue({
            projectId: pario.id,
            id: runId,
            workflowId: workflow.id,
            input: snapshot,
            queuedAt,
          })

          let jobId = ""
          try {
            const [job] = await pario.queues.workflows.enqueue({
              projectId: pario.id,
              jobs: [
                {
                  type: "workflow.run.requested",
                  payload: { workflowId: workflow.id, runId, input },
                },
              ],
            })
            jobId = job?.id ?? ""
          } catch (error) {
            await storage.finish({
              projectId: pario.id,
              id: runId,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          }

          await pario.events
            .append({
              events: [
                {
                  type: "workflow.run.queued",
                  payload: {
                    workflowId: workflow.id,
                    runId,
                    queuedAt: queuedAt.toISOString(),
                    ...(jobId ? { jobId } : {}),
                    source: { type: "manual" },
                  },
                },
              ],
            })
            .catch((error: unknown) => {
              console.error("[ParioServer] Failed to emit workflow.run.queued:", error)
            })

          set.status = 202
          return RequestWorkflowRunResponseSchema.parse({
            runId,
            jobId,
            workflowId: workflow.id,
            queuedAt: queuedAt.toISOString(),
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: WorkflowParamsSchema,
        body: RequestWorkflowRunBodySchema,
        response: {
          202: RequestWorkflowRunResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Request a workflow run",
          tags: ["Workflows"],
          operationId: "requestWorkflowRun",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
