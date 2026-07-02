import {
  canViewWorkflowIntervention,
  canViewWorkflowRun,
  type OntologySource,
  type Sixb,
  snapshotWorkflowInterventionResponse,
  type WorkflowDefinition,
  type WorkflowInterventionNodeDefinition,
  type WorkflowInterventionRecord,
  type WorkflowNodeRunRecord,
  type WorkflowRunRecord,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { ZodError, z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import {
  createFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
  resolveFileRefAtPath,
} from "../files/content"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
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

const WorkflowRunFileContentQuerySchema = FileContentQuerySchema.extend({
  path: z
    .string()
    .min(1)
    .regex(/^\/input(?:\/|$)/, "Workflow run file content paths must start with /input/"),
})

const WorkflowNodeFileContentQuerySchema = FileContentQuerySchema.extend({
  path: z
    .string()
    .min(1)
    .regex(
      /^\/(?:input|output)(?:\/|$)/,
      "Workflow node file content paths must start with /input/ or /output/"
    ),
})

const WorkflowNodeFileContentParamsSchema = WorkflowRunParamsSchema.extend({
  nodeKey: z.string().min(1),
})

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

type SerializedWorkflowRun = ReturnType<typeof serializeWorkflowRun>

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

async function workflowRunFileContentResponse(
  sixb: Sixb<readonly OntologySource[]>,
  context: {
    readonly params: { readonly runId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const { authz } = requestAuthState(context)

  try {
    const storage = sixb.storage.workflowRuns
    if (!storage) {
      context.set.status = 400
      return { error: "Workflow run storage is not configured" }
    }

    const parsed = WorkflowRunFileContentQuerySchema.parse(context.query)
    const run = await storage.getById({ projectId: sixb.id, id: context.params.runId })
    if (!run || !canViewWorkflowRun(authz, run)) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const fileRef = resolveFileRefAtPath(serializeWorkflowRun(run), parsed.path)
    if (!fileRef) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const response = await createFileContentResponse({
      blobStorage: sixb.blobStorage,
      fileRef,
      disposition: parsed.disposition,
      head: options.head,
      rangeHeader: context.request.headers.get("range"),
    })
    if (!response) {
      context.set.status = 404
      return { error: "File not found" }
    }

    return response
  } catch (error) {
    if (error instanceof ZodError) {
      context.set.status = 400
      return { error: "Invalid file content query" }
    }

    throw error
  }
}

async function workflowNodeFileContentResponse(
  sixb: Sixb<readonly OntologySource[]>,
  context: {
    readonly params: { readonly runId: string; readonly nodeKey: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const { authz } = requestAuthState(context)

  try {
    const storage = sixb.storage.workflowRuns
    if (!storage) {
      context.set.status = 400
      return { error: "Workflow run storage is not configured" }
    }

    const parsed = WorkflowNodeFileContentQuerySchema.parse(context.query)
    const run = await storage.getById({ projectId: sixb.id, id: context.params.runId })
    if (!run || !canViewWorkflowRun(authz, run)) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const result = await storage.nodes.list({
      projectId: sixb.id,
      workflowRunId: run.id,
      nodeKey: context.params.nodeKey,
      limit: 1,
      order: "asc",
    })
    const [node] = result.nodes
    if (!node) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const fileRef = resolveFileRefAtPath(serializeWorkflowNodeRun(node), parsed.path)
    if (!fileRef) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const response = await createFileContentResponse({
      blobStorage: sixb.blobStorage,
      fileRef,
      disposition: parsed.disposition,
      head: options.head,
      rangeHeader: context.request.headers.get("range"),
    })
    if (!response) {
      context.set.status = 404
      return { error: "File not found" }
    }

    return response
  } catch (error) {
    if (error instanceof ZodError) {
      context.set.status = 400
      return { error: "Invalid file content query" }
    }

    throw error
  }
}

async function getLatestWorkflowRun(
  sixb: Sixb<readonly OntologySource[]>,
  workflowId: string
): Promise<SerializedWorkflowRun | null> {
  if (!sixb.storage.workflowRuns) {
    return null
  }

  const storage = sixb.storage.workflowRuns
  const result = await storage.listLatestByWorkflowIds({
    projectId: sixb.id,
    workflowIds: [workflowId],
  })

  const [latest] = result.runs
  return latest ? serializeWorkflowRun(latest) : null
}

async function getLatestWorkflowRuns(
  sixb: Sixb<readonly OntologySource[]>,
  workflowIds: readonly string[]
): Promise<Map<string, SerializedWorkflowRun>> {
  const storage = sixb.storage.workflowRuns
  if (!storage || workflowIds.length === 0) {
    return new Map()
  }

  const result = await storage.listLatestByWorkflowIds({
    projectId: sixb.id,
    workflowIds,
  })

  return new Map(result.runs.map((run) => [run.workflowId, serializeWorkflowRun(run)]))
}

function serializeWorkflow(
  workflow: WorkflowDefinition,
  latestRun: SerializedWorkflowRun | null
): ReturnType<typeof WorkflowSchema.parse> {
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
          ...(node.action.binding.kind === "object"
            ? { objectTypeId: node.action.binding.objectType.id }
            : {}),
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
    latestRun,
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
      `[SixbServer] Workflow intervention '${intervention.id}' does not match a registered intervention node.`
    )
  }

  return node
}

function assertPendingIntervention(intervention: WorkflowInterventionRecord): void {
  if (intervention.status !== "pending") {
    throw new Error(`[SixbServer] Workflow intervention '${intervention.id}' is not pending.`)
  }
}

async function emitWorkflowInterventionSubmitted(
  sixb: Sixb<readonly OntologySource[]>,
  intervention: WorkflowInterventionRecord
): Promise<void> {
  if (!intervention.submittedAt) {
    throw new Error(`[SixbServer] Submitted intervention '${intervention.id}' has no submittedAt.`)
  }

  await sixb.events.append({
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
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly workflow: WorkflowDefinition
  readonly intervention: WorkflowInterventionRecord
  readonly node: WorkflowNodeRunRecord
  readonly run: WorkflowRunRecord
}): Promise<void> {
  const { sixb, workflow, intervention, node, run } = input
  if (!intervention.cancelledAt) {
    throw new Error(`[SixbServer] Cancelled intervention '${intervention.id}' has no cancelledAt.`)
  }
  if (!node.finishedAt) {
    throw new Error(`[SixbServer] Cancelled workflow node run '${node.id}' has no finishedAt.`)
  }
  if (!run.finishedAt) {
    throw new Error(`[SixbServer] Cancelled workflow run '${run.id}' has no finishedAt.`)
  }

  await sixb.events.append({
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

export function registerWorkflowRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/workflows",
      async (context) => {
        const { scoped } = requestAuthState(context)
        const workflows = scoped ? scoped.listWorkflows() : sixb.workflows.list()
        const latestRuns = await getLatestWorkflowRuns(
          sixb,
          workflows.map((workflow) => workflow.id)
        )

        return workflows.map((workflow) =>
          serializeWorkflow(workflow, latestRuns.get(workflow.id) ?? null)
        )
      },
      {
        response: { 200: WorkflowSchema.array() },
        detail: {
          summary: "List registered workflows",
          tags: [OPENAPI_TAGS.workflows.name],
          operationId: "listWorkflows",
          security: bearerSecurityRequirement("listWorkflows"),
        },
      }
    )
    .get(
      "/api/workflows/:workflowId",
      async (context) => {
        const { params, set } = context
        const { scoped } = requestAuthState(context)
        // Non-runnable workflows are hidden as 404 (existence-hiding), matching
        // the object/action read routes.
        const workflow = scoped
          ? scoped.getWorkflowById(params.workflowId)
          : sixb.workflows.getById(params.workflowId)
        if (!workflow) {
          set.status = 404
          return { error: "Workflow not found" }
        }

        return serializeWorkflow(workflow, await getLatestWorkflowRun(sixb, workflow.id))
      },
      {
        params: WorkflowParamsSchema,
        response: { 200: WorkflowSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get workflow metadata",
          tags: [OPENAPI_TAGS.workflows.name],
          operationId: "getWorkflow",
          security: bearerSecurityRequirement("getWorkflow"),
        },
      }
    )
    .get(
      "/api/workflow-interventions",
      async (context) => {
        const { query, set } = context
        const { authz } = requestAuthState(context)
        try {
          const parsed = WorkflowInterventionsQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const storage = sixb.storage.workflowInterventions
          if (!storage) {
            return { interventions: [], hasMore: false, total: 0 }
          }

          const workflowIds = authz ? [...authz.grants["run:workflow"]] : undefined
          const result = await storage.list({
            projectId: sixb.id,
            workflowId: parsed.workflowId,
            workflowIds,
            workflowRunId: parsed.workflowRunId,
            nodeRunId: parsed.nodeRunId,
            nodeId: parsed.nodeId,
            nodeKey: parsed.nodeKey,
            interventionId: parsed.interventionId,
            statuses: parsed.status ? [parsed.status] : undefined,
            requestedAfter: parseDate(parsed.requestedAfter),
            requestedBefore: parseDate(parsed.requestedBefore),
            limit,
            offset,
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
          tags: [OPENAPI_TAGS.workflowInterventions.name],
          operationId: "listWorkflowInterventions",
        },
      }
    )
    .get(
      "/api/workflow-interventions/:interventionId",
      async (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.workflowInterventions
          if (!storage) {
            set.status = 400
            return { error: "Workflow intervention storage is not configured" }
          }

          const intervention = await storage.getById({
            projectId: sixb.id,
            id: params.interventionId,
          })
          if (!intervention || !canViewWorkflowIntervention(authz, intervention)) {
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
          tags: [OPENAPI_TAGS.workflowInterventions.name],
          operationId: "getWorkflowIntervention",
        },
      }
    )
    .post(
      "/api/workflow-interventions/:interventionId/submit",
      async ({ params, body, set }) => {
        try {
          const storage = sixb.storage.workflowInterventions
          if (!storage) {
            set.status = 400
            return { error: "Workflow intervention storage is not configured" }
          }

          const intervention = await storage.getById({
            projectId: sixb.id,
            id: params.interventionId,
          })
          if (!intervention) {
            set.status = 404
            return { error: "Workflow intervention not found" }
          }
          assertPendingIntervention(intervention)

          const workflow = sixb.workflows.getById(intervention.workflowId)
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
            valueTypesById: sixb.ontology.getValueTypesById(),
          })

          const submitted = await storage.submit({
            projectId: sixb.id,
            id: intervention.id,
            response,
            submittedBy: parsedBody.submittedBy,
          })

          const [job] = await sixb.queues.workflows.enqueue({
            projectId: sixb.id,
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

          await emitWorkflowInterventionSubmitted(sixb, submitted)

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
          tags: [OPENAPI_TAGS.workflowInterventions.name],
          operationId: "submitWorkflowIntervention",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/workflow-interventions/:interventionId/cancel",
      async ({ params, body, set }) => {
        try {
          const interventionStorage = sixb.storage.workflowInterventions
          if (!interventionStorage) {
            set.status = 400
            return { error: "Workflow intervention storage is not configured" }
          }

          const runStorage = sixb.storage.workflowRuns
          if (!runStorage) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }

          const intervention = await interventionStorage.getById({
            projectId: sixb.id,
            id: params.interventionId,
          })
          if (!intervention) {
            set.status = 404
            return { error: "Workflow intervention not found" }
          }
          assertPendingIntervention(intervention)

          const workflow = sixb.workflows.getById(intervention.workflowId)
          if (!workflow) {
            set.status = 404
            return { error: "Workflow not found" }
          }
          requireRegisteredInterventionNode(workflow, intervention)

          const run = await runStorage.getById({
            projectId: sixb.id,
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
            projectId: sixb.id,
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
            projectId: sixb.id,
            id: intervention.id,
            cancelledAt,
            cancelledBy: parsedBody.cancelledBy,
          })
          const cancelledNode = await runStorage.nodes.finish({
            projectId: sixb.id,
            id: intervention.nodeRunId,
            status: "cancelled",
            finishedAt: cancelledAt,
            error: "Workflow intervention cancelled.",
          })
          const cancelledRun = await runStorage.finish({
            projectId: sixb.id,
            id: intervention.workflowRunId,
            status: "cancelled",
            finishedAt: cancelledAt,
            error: "Workflow intervention cancelled.",
          })

          await emitWorkflowInterventionCancelled({
            sixb,
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
          tags: [OPENAPI_TAGS.workflowInterventions.name],
          operationId: "cancelWorkflowIntervention",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/workflow-runs",
      async (context) => {
        const { query, set } = context
        const { authz } = requestAuthState(context)
        try {
          const parsed = WorkflowRunsQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const storage = sixb.storage.workflowRuns
          if (!storage) {
            return { runs: [], hasMore: false, total: 0 }
          }

          const workflowIds = authz ? [...authz.grants["run:workflow"]] : undefined
          const result = await storage.list({
            projectId: sixb.id,
            workflowId: parsed.workflowId,
            workflowIds,
            statuses: parsed.status ? [parsed.status] : undefined,
            startedAfter: parseDate(parsed.startedAfter),
            startedBefore: parseDate(parsed.startedBefore),
            limit,
            offset,
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
          tags: [OPENAPI_TAGS.workflowRuns.name],
          operationId: "listWorkflowRuns",
        },
      }
    )
    .get(
      "/api/workflow-runs/:runId",
      async (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.workflowRuns
          if (!storage) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }

          const run = await storage.getById({ projectId: sixb.id, id: params.runId })
          if (!run || !canViewWorkflowRun(authz, run)) {
            set.status = 404
            return { error: "Workflow run not found" }
          }

          const nodes = await storage.nodes.list({
            projectId: sixb.id,
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
          tags: [OPENAPI_TAGS.workflowRuns.name],
          operationId: "getWorkflowRun",
        },
      }
    )
    .get(
      "/api/workflow-runs/:runId/files/content",
      (context) => workflowRunFileContentResponse(sixb, context),
      {
        params: WorkflowRunParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Get workflow run file content",
          tags: ["Workflows"],
          operationId: "getWorkflowRunFileContent",
          security: bearerSecurityRequirement("getWorkflowRunFileContent"),
          responses: fileContentGetResponses(),
        },
      }
    )
    .head(
      "/api/workflow-runs/:runId/files/content",
      (context) => workflowRunFileContentResponse(sixb, context, { head: true }),
      {
        params: WorkflowRunParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Head workflow run file content",
          tags: ["Workflows"],
          operationId: "headWorkflowRunFileContent",
          security: bearerSecurityRequirement("headWorkflowRunFileContent"),
          responses: fileContentHeadResponses(),
        },
      }
    )
    .get(
      "/api/workflow-runs/:runId/nodes/:nodeKey/files/content",
      (context) => workflowNodeFileContentResponse(sixb, context),
      {
        params: WorkflowNodeFileContentParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Get workflow node run file content",
          tags: ["Workflows"],
          operationId: "getWorkflowNodeRunFileContent",
          security: bearerSecurityRequirement("getWorkflowNodeRunFileContent"),
          responses: fileContentGetResponses(),
        },
      }
    )
    .head(
      "/api/workflow-runs/:runId/nodes/:nodeKey/files/content",
      (context) => workflowNodeFileContentResponse(sixb, context, { head: true }),
      {
        params: WorkflowNodeFileContentParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Head workflow node run file content",
          tags: ["Workflows"],
          operationId: "headWorkflowNodeRunFileContent",
          security: bearerSecurityRequirement("headWorkflowNodeRunFileContent"),
          responses: fileContentHeadResponses(),
        },
      }
    )
    .post(
      "/api/workflows/:workflowId/runs",
      async (context) => {
        const { params, body, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const workflow = sixb.workflows.getById(params.workflowId)
          if (!workflow) {
            set.status = 404
            return { error: "Workflow not found" }
          }

          if (!sixb.storage.workflowRuns) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }

          const parsedBody = RequestWorkflowRunBodySchema.parse(body)
          const input = {
            workflowId: workflow.id,
            input: parsedBody.input ?? {},
            source: { type: "manual" } as const,
          }
          const result = scoped
            ? await scoped.runWorkflow(input)
            : await sixb.workflows.requestById(input)

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
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Request a workflow run",
          tags: [OPENAPI_TAGS.workflowRuns.name],
          operationId: "requestWorkflowRun",
          security: bearerSecurityRequirement("requestWorkflowRun"),
        },
      }
    )
}
