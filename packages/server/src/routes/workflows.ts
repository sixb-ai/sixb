import type {
  OntologySource,
  Pario,
  WorkflowDefinition,
  WorkflowInterventionNodeDefinition,
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
} from "@pario/core"
import { snapshotWorkflowInterventionResponse } from "@pario/core"
import type { Elysia } from "elysia"
import { PARIO_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { ErrorResponseSchema } from "../schemas/common"
import {
  CancelWorkflowInterventionBodySchema,
  CancelWorkflowInterventionResponseSchema,
  RequestWorkflowRunBodySchema,
  RequestWorkflowRunResponseSchema,
  SubmitWorkflowInterventionBodySchema,
  SubmitWorkflowInterventionResponseSchema,
  WorkflowInterventionListResponseSchema,
  WorkflowInterventionParamsSchema,
  WorkflowInterventionSchema,
  WorkflowInterventionsQuerySchema,
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

function serializeWorkflowIntervention(intervention: WorkflowInterventionRecord) {
  return {
    id: intervention.id,
    projectId: intervention.projectId,
    workflowId: intervention.workflowId,
    workflowRunId: intervention.workflowRunId,
    nodeRunId: intervention.nodeRunId,
    nodeIndex: intervention.nodeIndex,
    nodeId: intervention.nodeId,
    nodeKey: intervention.nodeKey,
    interventionId: intervention.interventionId,
    input: intervention.input,
    defaultResponse: intervention.defaultResponse,
    status: intervention.status,
    requestedAt: toIsoString(intervention.requestedAt),
    expiresAt: intervention.expiresAt ? toIsoString(intervention.expiresAt) : undefined,
    submittedAt: intervention.submittedAt ? toIsoString(intervention.submittedAt) : undefined,
    submittedBy: intervention.submittedBy,
    response: intervention.response,
    cancelledAt: intervention.cancelledAt ? toIsoString(intervention.cancelledAt) : undefined,
    cancelledBy: intervention.cancelledBy,
    expiredAt: intervention.expiredAt ? toIsoString(intervention.expiredAt) : undefined,
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

      if (node.type === "action") {
        return {
          type: "action" as const,
          id: node.id,
          key: node.key,
          targetObjectTypeId: node.action.target.id,
          params: node.action.params,
        }
      }

      return {
        type: "intervention" as const,
        id: node.id,
        key: node.key,
        input: node.intervention.input,
        response: node.intervention.response,
        description: node.intervention.description,
      }
    }),
    latestRun: await getLatestWorkflowRun(pario, workflow.id),
  })
}

function requireRegisteredInterventionNode(
  workflow: WorkflowDefinition,
  intervention: WorkflowInterventionRecord
): WorkflowInterventionNodeDefinition {
  const node = workflow.nodes[intervention.nodeIndex]
  if (
    node?.type !== "intervention" ||
    node.id !== intervention.nodeId ||
    node.key !== intervention.nodeKey ||
    node.intervention.id !== intervention.interventionId
  ) {
    throw new Error(
      `[ParioServer] Workflow intervention '${intervention.id}' does not match a registered intervention node.`
    )
  }

  return node
}

function assertPendingIntervention(intervention: WorkflowInterventionRecord): void {
  if (intervention.status !== "pending") {
    throw new Error(`[ParioServer] Workflow intervention '${intervention.id}' is not pending.`)
  }
}

async function emitWorkflowInterventionSubmitted(
  pario: Pario<readonly OntologySource[]>,
  intervention: WorkflowInterventionRecord
): Promise<void> {
  if (!intervention.submittedAt) {
    throw new Error(`[ParioServer] Submitted intervention '${intervention.id}' has no submittedAt.`)
  }

  await pario.events.append({
    events: [
      {
        type: "workflow.intervention.submitted",
        payload: {
          workflowId: intervention.workflowId,
          runId: intervention.workflowRunId,
          nodeRunId: intervention.nodeRunId,
          interventionId: intervention.interventionId,
          pendingInterventionId: intervention.id,
          submittedAt: intervention.submittedAt.toISOString(),
        },
      },
    ],
  })
}

async function emitWorkflowInterventionCancelled(input: {
  readonly pario: Pario<readonly OntologySource[]>
  readonly workflow: WorkflowDefinition
  readonly intervention: WorkflowInterventionRecord
  readonly node: WorkflowNodeRunRecord
  readonly run: WorkflowRunRecord
}): Promise<void> {
  const { pario, workflow, intervention, node, run } = input
  if (!intervention.cancelledAt) {
    throw new Error(`[ParioServer] Cancelled intervention '${intervention.id}' has no cancelledAt.`)
  }
  if (!node.finishedAt) {
    throw new Error(`[ParioServer] Cancelled workflow node run '${node.id}' has no finishedAt.`)
  }
  if (!run.finishedAt) {
    throw new Error(`[ParioServer] Cancelled workflow run '${run.id}' has no finishedAt.`)
  }

  await pario.events.append({
    events: [
      {
        type: "workflow.intervention.cancelled",
        payload: {
          workflowId: intervention.workflowId,
          runId: intervention.workflowRunId,
          nodeRunId: intervention.nodeRunId,
          interventionId: intervention.interventionId,
          pendingInterventionId: intervention.id,
          cancelledAt: intervention.cancelledAt.toISOString(),
        },
      },
      {
        type: "workflow.run.node.finished",
        payload: {
          workflowId: node.workflowId,
          runId: node.workflowRunId,
          nodeRunId: node.id,
          nodeIndex: node.nodeIndex,
          totalNodes: workflow.nodes.length,
          nodeType: node.nodeType,
          nodeId: node.nodeId,
          nodeKey: node.nodeKey,
          status: "cancelled",
          finishedAt: node.finishedAt.toISOString(),
          ...(node.error ? { error: node.error } : {}),
        },
      },
      {
        type: "workflow.run.finished",
        payload: {
          workflowId: run.workflowId,
          runId: run.id,
          status: "cancelled",
          finishedAt: run.finishedAt.toISOString(),
          ...(run.error ? { error: run.error } : {}),
        },
      },
    ],
  })
}

export function registerWorkflowRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app
    .get(
      "/api/workflows",
      async () => {
        return await Promise.all(
          pario.workflows.list().map((workflow) => serializeWorkflow(pario, workflow))
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
        const workflow = pario.workflows.getById(params.workflowId)
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
      "/api/workflow-interventions",
      async ({ query, set }) => {
        try {
          const parsed = WorkflowInterventionsQuerySchema.parse(query)
          const storage = pario.storage.workflowInterventions
          if (!storage) {
            return { interventions: [], hasMore: false, total: 0 }
          }

          const result = await storage.list({
            projectId: pario.id,
            workflowId: parsed.workflowId,
            workflowRunId: parsed.workflowRunId,
            nodeRunId: parsed.nodeRunId,
            nodeId: parsed.nodeId,
            nodeKey: parsed.nodeKey,
            interventionId: parsed.interventionId,
            statuses: parsed.status ? [parsed.status] : undefined,
            requestedAfter: parseDate(parsed.requestedAfter),
            requestedBefore: parseDate(parsed.requestedBefore),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })

          return WorkflowInterventionListResponseSchema.parse({
            interventions: result.interventions.map(serializeWorkflowIntervention),
            hasMore: result.hasMore,
            total: result.total,
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: WorkflowInterventionsQuerySchema,
        response: { 200: WorkflowInterventionListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List workflow interventions",
          tags: ["Workflows"],
          operationId: "listWorkflowInterventions",
        },
      }
    )
    .get(
      "/api/workflow-interventions/:interventionId",
      async ({ params, set }) => {
        try {
          const storage = pario.storage.workflowInterventions
          if (!storage) {
            set.status = 400
            return { error: "Workflow intervention storage is not configured" }
          }

          const intervention = await storage.getById({
            projectId: pario.id,
            id: params.interventionId,
          })
          if (!intervention) {
            set.status = 404
            return { error: "Workflow intervention not found" }
          }

          return WorkflowInterventionSchema.parse(serializeWorkflowIntervention(intervention))
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: WorkflowInterventionParamsSchema,
        response: {
          200: WorkflowInterventionSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get workflow intervention detail",
          tags: ["Workflows"],
          operationId: "getWorkflowIntervention",
        },
      }
    )
    .post(
      "/api/workflow-interventions/:interventionId/submit",
      async ({ params, body, set }) => {
        try {
          const storage = pario.storage.workflowInterventions
          if (!storage) {
            set.status = 400
            return { error: "Workflow intervention storage is not configured" }
          }

          const intervention = await storage.getById({
            projectId: pario.id,
            id: params.interventionId,
          })
          if (!intervention) {
            set.status = 404
            return { error: "Workflow intervention not found" }
          }
          assertPendingIntervention(intervention)

          const workflow = pario.workflows.getById(intervention.workflowId)
          if (!workflow) {
            set.status = 404
            return { error: "Workflow not found" }
          }

          const node = requireRegisteredInterventionNode(workflow, intervention)
          const parsedBody = SubmitWorkflowInterventionBodySchema.parse(body)
          const response = snapshotWorkflowInterventionResponse({
            workflowId: workflow.id,
            intervention: node.intervention,
            value: parsedBody.response,
            valueTypesById: pario.ontology.getValueTypesById(),
          })

          const submitted = await storage.submit({
            projectId: pario.id,
            id: intervention.id,
            response,
            submittedBy: parsedBody.submittedBy,
          })

          const [job] = await pario.queues.workflows.enqueue({
            projectId: pario.id,
            jobs: [
              {
                type: "workflow.run.resume.requested",
                payload: {
                  workflowId: submitted.workflowId,
                  runId: submitted.workflowRunId,
                  pendingInterventionId: submitted.id,
                },
              },
            ],
          })

          await emitWorkflowInterventionSubmitted(pario, submitted)

          set.status = 202
          return SubmitWorkflowInterventionResponseSchema.parse({
            intervention: serializeWorkflowIntervention(submitted),
            jobId: job?.id ?? "",
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: WorkflowInterventionParamsSchema,
        body: SubmitWorkflowInterventionBodySchema,
        response: {
          202: SubmitWorkflowInterventionResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Submit a workflow intervention response",
          tags: ["Workflows"],
          operationId: "submitWorkflowIntervention",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/workflow-interventions/:interventionId/cancel",
      async ({ params, body, set }) => {
        try {
          const interventionStorage = pario.storage.workflowInterventions
          if (!interventionStorage) {
            set.status = 400
            return { error: "Workflow intervention storage is not configured" }
          }

          const runStorage = pario.storage.workflowRuns
          if (!runStorage) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }

          const intervention = await interventionStorage.getById({
            projectId: pario.id,
            id: params.interventionId,
          })
          if (!intervention) {
            set.status = 404
            return { error: "Workflow intervention not found" }
          }
          assertPendingIntervention(intervention)

          const workflow = pario.workflows.getById(intervention.workflowId)
          if (!workflow) {
            set.status = 404
            return { error: "Workflow not found" }
          }
          requireRegisteredInterventionNode(workflow, intervention)

          const run = await runStorage.getById({
            projectId: pario.id,
            id: intervention.workflowRunId,
          })
          if (!run) {
            set.status = 404
            return { error: "Workflow run not found" }
          }
          if (run.status !== "waiting") {
            set.status = 400
            return { error: "Workflow run is not waiting" }
          }

          const nodeRun = await runStorage.nodes.getById({
            projectId: pario.id,
            id: intervention.nodeRunId,
          })
          if (!nodeRun) {
            set.status = 404
            return { error: "Workflow node run not found" }
          }
          if (nodeRun.status !== "waiting") {
            set.status = 400
            return { error: "Workflow node run is not waiting" }
          }

          const parsedBody = CancelWorkflowInterventionBodySchema.parse(body ?? {})
          const cancelledAt = new Date()
          const cancelled = await interventionStorage.cancel({
            projectId: pario.id,
            id: intervention.id,
            cancelledAt,
            cancelledBy: parsedBody.cancelledBy,
          })
          const cancelledNode = await runStorage.nodes.finish({
            projectId: pario.id,
            id: intervention.nodeRunId,
            status: "cancelled",
            finishedAt: cancelledAt,
            error: "Workflow intervention cancelled.",
          })
          const cancelledRun = await runStorage.finish({
            projectId: pario.id,
            id: intervention.workflowRunId,
            status: "cancelled",
            finishedAt: cancelledAt,
            error: "Workflow intervention cancelled.",
          })

          await emitWorkflowInterventionCancelled({
            pario,
            workflow,
            intervention: cancelled,
            node: cancelledNode,
            run: cancelledRun,
          })

          return CancelWorkflowInterventionResponseSchema.parse({
            intervention: serializeWorkflowIntervention(cancelled),
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: WorkflowInterventionParamsSchema,
        body: CancelWorkflowInterventionBodySchema,
        response: {
          200: CancelWorkflowInterventionResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Cancel a workflow intervention",
          tags: ["Workflows"],
          operationId: "cancelWorkflowIntervention",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
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
          const workflow = pario.workflows.getById(params.workflowId)
          if (!workflow) {
            set.status = 404
            return { error: "Workflow not found" }
          }

          if (!pario.storage.workflowRuns) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }

          const parsedBody = RequestWorkflowRunBodySchema.parse(body)
          const result = await pario.workflows.requestById({
            workflowId: workflow.id,
            input: parsedBody.input ?? {},
            source: { type: "manual" },
          })

          set.status = 202
          return RequestWorkflowRunResponseSchema.parse({
            runId: result.runId,
            jobId: result.jobId ?? "",
            workflowId: result.workflowId,
            queuedAt: result.queuedAt,
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
