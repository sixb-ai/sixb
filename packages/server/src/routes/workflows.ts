import {
  type OntologySource,
  type Principal,
  type SixbHostView,
  SYSTEM_PRINCIPAL,
  type WorkflowAgentNodeRunView,
  type WorkflowDefinition,
  type WorkflowNodeRunView,
} from "@sixb/core"
import { publishAgentRunCancel } from "@sixb/core/internal/agents"
import { createSixbError, toSixbFailure } from "@sixb/core/internal/errors"
import type { Sixb, WorkflowRunView } from "@sixb/core/internal/request-execution"
import {
  snapshotWorkflowInterventionResponse,
  type WorkflowInterventionNodeDefinition,
} from "@sixb/core/internal/workflows"
import type {
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
} from "@sixb/core/storage"
import { AGENT_RUN_FAILURE_CODES, WORKFLOW_RUN_FAILURE_CODES } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState, requireRequestSixb } from "../auth/scope"
import {
  createContextualFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
  handleFileContentQueryValidationError,
} from "../files/content"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import {
  CancelWorkflowInterventionBodySchema,
  CancelWorkflowInterventionResponseSchema,
  CancelWorkflowRunBodySchema,
  CancelWorkflowRunResponseSchema,
  RequestWorkflowRunBodySchema,
  RequestWorkflowRunResponseSchema,
  SubmitWorkflowInterventionBodySchema,
  SubmitWorkflowInterventionResponseSchema,
  WorkflowAgentNodeExecutionSchema,
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
import {
  handleRouteError,
  parseDate,
  parseOptionalInt,
  toIsoString,
  unconfiguredStorageResponse,
} from "../utils/http"

const WorkflowRunFileContentQuerySchema = FileContentQuerySchema.extend({
  path: z
    .string()
    .min(1)
    .regex(
      /^\/(?:input|output)(?:\/|$)/,
      "Workflow run file content paths must start with /input/ or /output/"
    ),
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

function serializeWorkflowRunSummary(run: WorkflowRunView) {
  return {
    id: run.id,
    projectId: run.projectId,
    workflowId: run.workflowId,
    status: run.status,
    queuedAt: run.queuedAt ? toIsoString(run.queuedAt) : undefined,
    startedAt: toIsoString(run.startedAt),
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    error: run.error,
    requestedBy: serializePrincipal(run.requestedBy ?? SYSTEM_PRINCIPAL),
  }
}

function serializeWorkflowRunDetail(run: WorkflowRunView) {
  return {
    ...serializeWorkflowRunSummary(run),
    input: run.input,
    output: run.output,
  }
}

type SerializedWorkflowRun = ReturnType<typeof serializeWorkflowRunSummary>

function serializeWorkflowNodeRun(node: WorkflowNodeRunView) {
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
    ...(node.agentExecution
      ? { agentExecution: serializeWorkflowAgentExecutionSummary(node.agentExecution) }
      : {}),
  }
}

function serializePrincipal(principal: Principal) {
  return { principalType: principal.type, principalId: principal.id }
}

function serializeWorkflowAgentExecutionSummary(execution: WorkflowAgentNodeRunView) {
  return {
    status: execution.status,
    attempt: execution.attempt,
    modelId: execution.modelId,
    finishReason: execution.finishReason,
    usage: execution.usage,
    cost: execution.cost,
    startedAt: execution.startedAt ? toIsoString(execution.startedAt) : undefined,
    completedAt: execution.completedAt ? toIsoString(execution.completedAt) : undefined,
  }
}

function serializeWorkflowAgentExecution(execution: WorkflowAgentNodeRunView) {
  return {
    ...serializeWorkflowAgentExecutionSummary(execution),
    nodeRunId: execution.nodeRunId,
    prompt: execution.prompt,
    trace: execution.trace,
    diagnostics: execution.diagnostics,
    failurePhase: workflowAgentFailurePhase(execution),
    error: execution.error,
    createdAt: toIsoString(execution.createdAt),
  }
}

function workflowAgentFailurePhase(
  execution: WorkflowAgentNodeRunView
): "agent-loop" | "structured-finalizer" | undefined {
  const details = execution.error?.details
  if (!isRecord(details)) return undefined

  const phase = details.failurePhase
  return phase === "agent-loop" || phase === "structured-finalizer" ? phase : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function principalForExecution(sixb: Sixb<readonly OntologySource[]>): Principal {
  return sixb.execution.requestedBy ?? SYSTEM_PRINCIPAL
}

function toWorkflowCancellationFailure(input: {
  readonly message: string
  readonly at: Date
  readonly workflowId: string
  readonly runId: string
  readonly nodeRunId?: string
}) {
  const details: Readonly<Record<string, string>> = input.nodeRunId
    ? {
        workflowId: input.workflowId,
        workflowRunId: input.runId,
        nodeRunId: input.nodeRunId,
      }
    : { workflowId: input.workflowId, workflowRunId: input.runId }
  return toSixbFailure(createSixbError("runtime.cancelled", input.message, { details }), {
    allowedCodes: WORKFLOW_RUN_FAILURE_CODES,
    at: input.at,
  })
}

function toAgentCancellationFailure(input: {
  readonly message: string
  readonly at: Date
  readonly agentStepId: string
  readonly workflowId: string
  readonly runId: string
  readonly nodeRunId: string
}) {
  return toSixbFailure(
    createSixbError("runtime.cancelled", input.message, {
      details: {
        agentStepId: input.agentStepId,
        workflowId: input.workflowId,
        workflowRunId: input.runId,
        nodeRunId: input.nodeRunId,
      },
    }),
    {
      allowedCodes: AGENT_RUN_FAILURE_CODES,
      at: input.at,
    }
  )
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
  host: SixbHostView,
  context: {
    readonly params: { readonly runId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const sixb = requireRequestSixb(context)

  const storage = host.storage.workflowRuns
  if (!storage) {
    return unconfiguredStorageResponse(context.set, "Workflow run storage")
  }

  return createContextualFileContentResponse({
    blobStorage: host.blobStorage,
    query: context.query,
    querySchema: WorkflowRunFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    resolveRoot: async () => {
      const run = await sixb.workflows.runs.getById(context.params.runId)
      return run ? serializeWorkflowRunDetail(run) : null
    },
  })
}

async function workflowNodeFileContentResponse(
  host: SixbHostView,
  context: {
    readonly params: { readonly runId: string; readonly nodeKey: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const sixb = requireRequestSixb(context)

  const storage = host.storage.workflowRuns
  if (!storage) {
    return unconfiguredStorageResponse(context.set, "Workflow run storage")
  }

  return createContextualFileContentResponse({
    blobStorage: host.blobStorage,
    query: context.query,
    querySchema: WorkflowNodeFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    resolveRoot: async () => {
      const run = await sixb.workflows.runs.getById(context.params.runId)
      if (!run) {
        return null
      }

      const result = await sixb.workflows.runs.listNodes(run.id, {
        nodeKey: context.params.nodeKey,
        limit: 1,
        order: "asc",
      })
      const [node] = result?.nodes ?? []
      if (!node) {
        return null
      }

      return serializeWorkflowNodeRun(node)
    },
  })
}

async function getLatestWorkflowRun(
  sixb: ReturnType<typeof requireRequestSixb>,
  workflowId: string
): Promise<SerializedWorkflowRun | null> {
  const result = await sixb.workflows.runs.listLatest([workflowId])

  const [latest] = result.runs
  return latest ? serializeWorkflowRunSummary(latest) : null
}

async function getLatestWorkflowRuns(
  sixb: ReturnType<typeof requireRequestSixb>,
  workflowIds: readonly string[]
): Promise<Map<string, SerializedWorkflowRun>> {
  if (workflowIds.length === 0) {
    return new Map()
  }

  const result = await sixb.workflows.runs.listLatest(workflowIds)

  return new Map(result.runs.map((run) => [run.workflowId, serializeWorkflowRunSummary(run)]))
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

      if (node.type === "agent") {
        return {
          type: "agent" as const,
          id: node.id,
          key: node.key,
          input: node.agentStep.input,
          output: node.agentStep.output,
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
  host: SixbHostView,
  intervention: WorkflowInterventionRecord
): Promise<void> {
  if (!intervention.submittedAt) {
    throw new Error(`[SixbServer] Submitted intervention '${intervention.id}' has no submittedAt.`)
  }

  await host.events.append({
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
  readonly host: SixbHostView
  readonly workflow: WorkflowDefinition
  readonly intervention: WorkflowInterventionRecord
  readonly node: WorkflowNodeRunRecord
  readonly run: WorkflowRunRecord
}): Promise<void> {
  const { host, workflow, intervention, node, run } = input
  if (!intervention.cancelledAt) {
    throw new Error(`[SixbServer] Cancelled intervention '${intervention.id}' has no cancelledAt.`)
  }
  if (!node.finishedAt) {
    throw new Error(`[SixbServer] Cancelled workflow node run '${node.id}' has no finishedAt.`)
  }
  if (!run.finishedAt) {
    throw new Error(`[SixbServer] Cancelled workflow run '${run.id}' has no finishedAt.`)
  }

  await host.events.append({
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

async function emitWorkflowRunCancelled(input: {
  readonly host: SixbHostView
  readonly workflow: WorkflowDefinition
  readonly run: WorkflowRunRecord
  readonly node?: WorkflowNodeRunRecord
}): Promise<void> {
  const { host, workflow, run, node } = input
  if (!run.finishedAt) {
    throw new Error(`[SixbServer] Cancelled workflow run '${run.id}' has no finishedAt.`)
  }
  await host.events.append({
    events: [
      ...(node?.finishedAt
        ? [
            {
              type: "workflow.run.node.finished" as const,
              payload: {
                workflowId: node.workflowId,
                runId: node.workflowRunId,
                nodeRunId: node.id,
                nodeIndex: node.nodeIndex,
                totalNodes: workflow.nodes.length,
                nodeType: node.nodeType,
                nodeId: node.nodeId,
                nodeKey: node.nodeKey,
                status: "cancelled" as const,
                finishedAt: node.finishedAt.toISOString(),
                ...(node.error ? { error: node.error } : {}),
              },
            },
          ]
        : []),
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

export function registerWorkflowRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/workflows",
      async (context) => {
        const sixb = requireRequestSixb(context)
        const workflows = sixb.workflows.list()
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
        const sixb = requireRequestSixb(context)
        // Non-runnable workflows are hidden as 404 (existence-hiding), matching
        // the object/action read routes.
        const workflow = sixb.workflows.getById(params.workflowId)
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
        const sixb = requireRequestSixb(context)
        try {
          const parsed = WorkflowInterventionsQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const storage = host.storage.workflowInterventions
          if (!storage) {
            return unconfiguredStorageResponse(set, "Workflow intervention storage")
          }

          const result = await sixb.workflows.interventions.list({
            workflowId: parsed.workflowId,
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
        response: {
          200: WorkflowInterventionListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
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
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.workflowInterventions
          if (!storage) {
            return unconfiguredStorageResponse(set, "Workflow intervention storage")
          }

          const intervention = await sixb.workflows.interventions.getById(params.interventionId)
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
          501: ErrorResponseSchema,
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
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.workflowInterventions
          if (!storage) {
            return unconfiguredStorageResponse(set, "Workflow intervention storage")
          }

          const intervention = await sixb.workflows.interventions.getById(params.interventionId)
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
            valueTypesById: host.definitions.ontology.getValueTypesById(),
          })

          const submitted = await storage.submit({
            projectId: host.id,
            id: intervention.id,
            response,
            submittedBy: serializePrincipal(principalForExecution(sixb)),
          })

          const [job] = await host.queues.workflows.enqueue({
            projectId: host.id,
            jobs: [
              {
                type: "workflow.run.resume.requested",
                payload: {
                  runId: submitted.workflowRunId,
                  nodeRunId: submitted.nodeRunId,
                },
              },
            ],
          })

          await emitWorkflowInterventionSubmitted(host, submitted)

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
          501: ErrorResponseSchema,
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
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const interventionStorage = host.storage.workflowInterventions
          if (!interventionStorage) {
            return unconfiguredStorageResponse(set, "Workflow intervention storage")
          }

          const runStorage = host.storage.workflowRuns
          if (!runStorage) {
            return unconfiguredStorageResponse(set, "Workflow run storage")
          }

          const intervention = await sixb.workflows.interventions.getById(params.interventionId)
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

          const run = await sixb.workflows.runs.getById(intervention.workflowRunId)
          if (!run) {
            set.status = 404
            return { error: "Workflow run not found" }
          }
          if (run.status !== "waiting") {
            set.status = 400
            return { error: "Workflow run is not waiting" }
          }

          const nodeRun = await runStorage.nodes.getById({
            projectId: host.id,
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

          CancelWorkflowInterventionBodySchema.parse(body ?? {})
          const cancelledAt = new Date()
          const cancellationMessage = "Workflow intervention cancelled."
          const { cancelled, cancelledNode, cancelledRun } = await host.storage.transaction(
            async (tx) => {
              if (!tx.workflowInterventions || !tx.workflowRuns) {
                throw new Error("[SixbServer] Workflow storage disappeared during cancellation.")
              }
              const cancelled = await tx.workflowInterventions.cancel({
                projectId: host.id,
                id: intervention.id,
                cancelledAt,
                cancelledBy: serializePrincipal(principalForExecution(sixb)),
              })
              const cancelledNode = await tx.workflowRuns.nodes.finish({
                projectId: host.id,
                id: intervention.nodeRunId,
                status: "cancelled",
                finishedAt: cancelledAt,
                error: toWorkflowCancellationFailure({
                  message: cancellationMessage,
                  at: cancelledAt,
                  workflowId: intervention.workflowId,
                  runId: intervention.workflowRunId,
                  nodeRunId: intervention.nodeRunId,
                }),
              })
              const cancelledRun = await tx.workflowRuns.finish({
                projectId: host.id,
                id: intervention.workflowRunId,
                status: "cancelled",
                finishedAt: cancelledAt,
                error: toWorkflowCancellationFailure({
                  message: cancellationMessage,
                  at: cancelledAt,
                  workflowId: intervention.workflowId,
                  runId: intervention.workflowRunId,
                }),
              })
              return { cancelled, cancelledNode, cancelledRun }
            }
          )

          await emitWorkflowInterventionCancelled({
            host,
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
          501: ErrorResponseSchema,
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
        const sixb = requireRequestSixb(context)
        try {
          const parsed = WorkflowRunsQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const storage = host.storage.workflowRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Workflow run storage")
          }

          const result = await sixb.workflows.runs.list({
            workflowId: parsed.workflowId,
            statuses: parsed.status ? [parsed.status] : undefined,
            startedAfter: parseDate(parsed.startedAfter),
            startedBefore: parseDate(parsed.startedBefore),
            limit,
            offset,
            order: parsed.order,
          })

          return {
            runs: result.runs.map(serializeWorkflowRunSummary),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: WorkflowRunsQuerySchema,
        response: {
          200: WorkflowRunListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List workflow run history",
          tags: [OPENAPI_TAGS.workflowRuns.name],
          operationId: "listWorkflowRuns",
          security: bearerSecurityRequirement("listWorkflowRuns"),
        },
      }
    )
    .get(
      "/api/workflow-runs/:runId",
      async (context) => {
        const { params, set } = context
        const { agentExecution } = requestAuthState(context)
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.workflowRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Workflow run storage")
          }

          const run = await sixb.workflows.runs.getById(params.runId)
          if (!run) {
            set.status = 404
            return { error: "Workflow run not found" }
          }

          const serializedRun = serializeWorkflowRunDetail(run)

          if (agentExecution) {
            return WorkflowRunDetailResponseSchema.parse({ run: serializedRun, nodes: [] })
          }

          const nodes = await sixb.workflows.runs.listNodes(run.id, { order: "asc" })
          if (!nodes) {
            throw new Error(
              `[SixbServer] Authorized workflow run '${run.id}' lost its execution view.`
            )
          }

          return WorkflowRunDetailResponseSchema.parse({
            run: serializedRun,
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
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Get workflow run detail",
          tags: [OPENAPI_TAGS.workflowRuns.name],
          operationId: "getWorkflowRun",
          security: bearerSecurityRequirement("getWorkflowRun"),
        },
      }
    )
    .get(
      "/api/workflow-runs/:runId/nodes/:nodeKey/agent-execution",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.workflowRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Workflow run storage")
          }
          const run = await sixb.workflows.runs.getById(params.runId)
          if (!run) {
            set.status = 404
            return { error: "Workflow agent execution not found" }
          }
          const listed = await sixb.workflows.runs.listNodes(run.id, {
            nodeKey: params.nodeKey,
            limit: 1,
            order: "asc",
          })
          const node = listed?.nodes[0]
          const execution = node?.nodeType === "agent" ? node.agentExecution : undefined
          if (!execution) {
            set.status = 404
            return { error: "Workflow agent execution not found" }
          }
          return WorkflowAgentNodeExecutionSchema.parse(serializeWorkflowAgentExecution(execution))
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: WorkflowNodeFileContentParamsSchema,
        response: {
          200: WorkflowAgentNodeExecutionSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Get workflow agent node execution detail",
          tags: [OPENAPI_TAGS.workflowRuns.name],
          operationId: "getWorkflowAgentNodeExecution",
          security: bearerSecurityRequirement("getWorkflowAgentNodeExecution"),
        },
      }
    )
    .post(
      "/api/workflow-runs/:runId/cancel",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          CancelWorkflowRunBodySchema.parse(body ?? {})
          const storage = host.storage.workflowRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Workflow run storage")
          }
          const existing = await sixb.workflows.runs.getById(params.runId)
          if (!existing) {
            set.status = 404
            return { error: "Workflow run not found" }
          }
          const workflow = sixb.workflows.getById(existing.workflowId)
          if (!workflow) {
            set.status = 404
            return { error: "Workflow not found" }
          }
          if (existing.status === "cancelled") {
            const nodes = await sixb.workflows.runs.listNodes(existing.id, { order: "asc" })
            if (!nodes) {
              throw new Error(
                `[SixbServer] Authorized workflow run '${existing.id}' lost its execution view.`
              )
            }
            return CancelWorkflowRunResponseSchema.parse({
              run: serializeWorkflowRunDetail(existing),
              nodes: nodes.nodes.map(serializeWorkflowNodeRun),
            })
          }
          if (existing.status === "succeeded" || existing.status === "failed") {
            set.status = 400
            return { error: `Workflow run is already ${existing.status}` }
          }
          const listed = await storage.nodes.list({
            projectId: host.id,
            workflowRunId: existing.id,
            order: "asc",
          })

          const cancelledAt = new Date()
          const cancellationMessage = "Workflow run cancelled."
          const result = await host.storage.transaction(async (tx) => {
            const runs = tx.workflowRuns
            if (!runs) {
              throw new Error("[SixbServer] Workflow storage disappeared during cancellation.")
            }
            const run = await runs.getById({ projectId: host.id, id: existing.id })
            if (!run || !["queued", "running", "waiting"].includes(run.status)) {
              throw new Error(`[SixbServer] Workflow run '${existing.id}' is no longer active.`)
            }
            const active = [...listed.nodes]
              .reverse()
              .find((node) => node.status === "running" || node.status === "waiting")
            let cancelledNode: WorkflowNodeRunRecord | undefined
            if (active?.nodeType === "agent") {
              const execution = await runs.agentNodes.getByNodeRunId({
                projectId: host.id,
                nodeRunId: active.id,
              })
              if (execution?.status === "queued" || execution?.status === "running") {
                await runs.agentNodes.cancel({
                  projectId: host.id,
                  nodeRunId: active.id,
                  completedAt: cancelledAt,
                  error: toAgentCancellationFailure({
                    message: cancellationMessage,
                    at: cancelledAt,
                    agentStepId: active.nodeId,
                    workflowId: run.workflowId,
                    runId: run.id,
                    nodeRunId: active.id,
                  }),
                })
              }
            }
            if (active?.nodeType === "intervention" && tx.workflowInterventions) {
              const pending = await tx.workflowInterventions.list({
                projectId: host.id,
                workflowRunId: run.id,
                nodeRunId: active.id,
                statuses: ["pending"],
                limit: 1,
              })
              const intervention = pending.interventions[0]
              if (intervention) {
                await tx.workflowInterventions.cancel({
                  projectId: host.id,
                  id: intervention.id,
                  cancelledAt,
                  cancelledBy: serializePrincipal(principalForExecution(sixb)),
                })
              }
            }
            if (active) {
              cancelledNode = await runs.nodes.finish({
                projectId: host.id,
                id: active.id,
                status: "cancelled",
                finishedAt: cancelledAt,
                error: toWorkflowCancellationFailure({
                  message: cancellationMessage,
                  at: cancelledAt,
                  workflowId: run.workflowId,
                  runId: run.id,
                  nodeRunId: active.id,
                }),
                executionToken: run.execution?.token,
              })
            }
            const cancelledRun = await runs.finish({
              projectId: host.id,
              id: run.id,
              status: "cancelled",
              finishedAt: cancelledAt,
              error: toWorkflowCancellationFailure({
                message: cancellationMessage,
                at: cancelledAt,
                workflowId: run.workflowId,
                runId: run.id,
              }),
              executionToken: run.execution?.token,
            })
            return { run: cancelledRun, node: cancelledNode }
          })

          await emitWorkflowRunCancelled({ host, workflow, ...result })
          if (result.node?.nodeType === "agent") {
            await publishAgentRunCancel(host.broker, {
              projectId: host.id,
              runId: result.node.id,
            }).catch((error) => {
              console.error(
                `[SixbServer] Could not signal cancellation for workflow agent node '${result.node?.id}'.`,
                error
              )
            })
          }
          const nodes = await sixb.workflows.runs.listNodes(existing.id, { order: "asc" })
          if (!nodes) {
            throw new Error(
              `[SixbServer] Authorized workflow run '${existing.id}' lost its execution view.`
            )
          }
          return CancelWorkflowRunResponseSchema.parse({
            run: serializeWorkflowRunDetail({
              ...result.run,
              ...(existing.requestedBy === undefined ? {} : { requestedBy: existing.requestedBy }),
            }),
            nodes: nodes.nodes.map(serializeWorkflowNodeRun),
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: WorkflowRunParamsSchema,
        body: CancelWorkflowRunBodySchema,
        response: {
          200: CancelWorkflowRunResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Cancel a workflow run",
          tags: [OPENAPI_TAGS.workflowRuns.name],
          operationId: "cancelWorkflowRun",
          security: bearerSecurityRequirement("cancelWorkflowRun"),
        },
      }
    )
    .get(
      "/api/workflow-runs/:runId/files/content",
      (context) => workflowRunFileContentResponse(host, context),
      {
        params: WorkflowRunParamsSchema,
        query: WorkflowRunFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Get workflow run file content",
          tags: ["Workflows"],
          operationId: "getWorkflowRunFileContent",
          security: bearerSecurityRequirement("getWorkflowRunFileContent"),
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .head(
      "/api/workflow-runs/:runId/files/content",
      (context) => workflowRunFileContentResponse(host, context, { head: true }),
      {
        params: WorkflowRunParamsSchema,
        query: WorkflowRunFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Head workflow run file content",
          tags: ["Workflows"],
          operationId: "headWorkflowRunFileContent",
          security: bearerSecurityRequirement("headWorkflowRunFileContent"),
          responses: fileContentHeadResponses({ optionalStorage: true }),
        },
      }
    )
    .get(
      "/api/workflow-runs/:runId/nodes/:nodeKey/files/content",
      (context) => workflowNodeFileContentResponse(host, context),
      {
        params: WorkflowNodeFileContentParamsSchema,
        query: WorkflowNodeFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Get workflow node run file content",
          tags: ["Workflows"],
          operationId: "getWorkflowNodeRunFileContent",
          security: bearerSecurityRequirement("getWorkflowNodeRunFileContent"),
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .head(
      "/api/workflow-runs/:runId/nodes/:nodeKey/files/content",
      (context) => workflowNodeFileContentResponse(host, context, { head: true }),
      {
        params: WorkflowNodeFileContentParamsSchema,
        query: WorkflowNodeFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Head workflow node run file content",
          tags: ["Workflows"],
          operationId: "headWorkflowNodeRunFileContent",
          security: bearerSecurityRequirement("headWorkflowNodeRunFileContent"),
          responses: fileContentHeadResponses({ optionalStorage: true }),
        },
      }
    )
    .post(
      "/api/workflows/:workflowId/runs",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          if (!host.storage.workflowRuns) {
            return unconfiguredStorageResponse(set, "Workflow run storage")
          }

          const parsedBody = RequestWorkflowRunBodySchema.parse(body)
          const input = {
            workflowId: params.workflowId,
            input: parsedBody.input ?? {},
            source: { type: "manual" } as const,
          }
          const result = await sixb.workflows.requestById(input)

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
          501: ErrorResponseSchema,
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
