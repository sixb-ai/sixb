import {
  type OntologySource,
  type Principal,
  type ScopedSixb,
  type Sixb,
  SYSTEM_PRINCIPAL,
  type WorkflowDefinition,
} from "@sixb/core"
import { publishAgentRunCancel } from "@sixb/core/internal/agents"
import { canViewWorkflowIntervention, canViewWorkflowRun } from "@sixb/core/internal/authorization"
import {
  snapshotWorkflowInterventionResponse,
  type WorkflowInterventionNodeDefinition,
} from "@sixb/core/internal/workflows"
import type {
  WorkflowAgentNodeRunRecord,
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import {
  createContextualFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
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
    requestedBy: serializePrincipal(run.requestedByPrincipal),
  }
}

type SerializedWorkflowRun = ReturnType<typeof serializeWorkflowRun>

function serializeWorkflowNodeRun(
  node: WorkflowNodeRunRecord,
  agentExecution?: WorkflowAgentNodeRunRecord | null
) {
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
    ...(agentExecution
      ? { agentExecution: serializeWorkflowAgentExecutionSummary(agentExecution) }
      : {}),
  }
}

function serializePrincipal(principal: Principal) {
  return { principalType: principal.type, principalId: principal.id }
}

function serializeWorkflowAgentExecutionSummary(execution: WorkflowAgentNodeRunRecord) {
  return {
    agentId: execution.agentId,
    status: execution.status,
    attempt: execution.attempt,
    modelId: execution.modelId,
    finishReason: execution.finishReason,
    usage: execution.usage,
    startedAt: execution.startedAt ? toIsoString(execution.startedAt) : undefined,
    completedAt: execution.completedAt ? toIsoString(execution.completedAt) : undefined,
  }
}

function serializeWorkflowAgentExecution(execution: WorkflowAgentNodeRunRecord) {
  return {
    ...serializeWorkflowAgentExecutionSummary(execution),
    nodeRunId: execution.nodeRunId,
    prompt: execution.prompt,
    executionPrincipal: execution.executionPrincipal
      ? serializePrincipal(execution.executionPrincipal)
      : undefined,
    trace: execution.trace,
    diagnostics: execution.diagnostics,
    error: execution.error,
    createdAt: toIsoString(execution.createdAt),
  }
}

async function serializeWorkflowNodeWithExecution(
  storage: WorkflowRunStorage,
  node: WorkflowNodeRunRecord
) {
  const execution =
    node.nodeType === "agent"
      ? await storage.agentNodes.getByNodeRunId({
          projectId: node.projectId,
          nodeRunId: node.id,
        })
      : null
  return serializeWorkflowNodeRun(node, execution)
}

function canAccessWorkflowRun(
  authz: ReturnType<typeof requestAuthState>["authz"],
  scoped: ScopedSixb<readonly OntologySource[]> | null,
  run: WorkflowRunRecord
): boolean {
  return (
    canViewWorkflowRun(authz, run) && (!scoped || scoped.getWorkflowById(run.workflowId) !== null)
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
  sixb: Sixb<readonly OntologySource[]>,
  context: {
    readonly params: { readonly runId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const { authz, scoped } = requestAuthState(context)

  const storage = sixb.storage.workflowRuns
  if (!storage) {
    context.set.status = 400
    return { error: "Workflow run storage is not configured" }
  }

  return createContextualFileContentResponse({
    blobStorage: sixb.blobStorage,
    query: context.query,
    querySchema: WorkflowRunFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    resolveRoot: async () => {
      const run = await storage.getById({ projectId: sixb.id, id: context.params.runId })
      if (!run || !canAccessWorkflowRun(authz, scoped, run)) {
        return null
      }

      return serializeWorkflowRun(run)
    },
  })
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
  const { authz, scoped } = requestAuthState(context)

  const storage = sixb.storage.workflowRuns
  if (!storage) {
    context.set.status = 400
    return { error: "Workflow run storage is not configured" }
  }

  return createContextualFileContentResponse({
    blobStorage: sixb.blobStorage,
    query: context.query,
    querySchema: WorkflowNodeFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    resolveRoot: async () => {
      const run = await storage.getById({ projectId: sixb.id, id: context.params.runId })
      if (!run || !canAccessWorkflowRun(authz, scoped, run)) {
        return null
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
        return null
      }

      return serializeWorkflowNodeRun(node)
    },
  })
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

      if (node.type === "agent") {
        return {
          type: "agent" as const,
          id: node.id,
          key: node.key,
          agentId: node.agentStep.agent.id,
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

async function emitWorkflowRunCancelled(input: {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly workflow: WorkflowDefinition
  readonly run: WorkflowRunRecord
  readonly node?: WorkflowNodeRunRecord
}): Promise<void> {
  const { sixb, workflow, run, node } = input
  if (!run.finishedAt) {
    throw new Error(`[SixbServer] Cancelled workflow run '${run.id}' has no finishedAt.`)
  }
  await sixb.events.append({
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
        const { authz, scoped } = requestAuthState(context)
        try {
          const parsed = WorkflowInterventionsQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const storage = sixb.storage.workflowInterventions
          if (!storage) {
            return { interventions: [], hasMore: false, total: 0 }
          }

          const workflowIds = scoped
            ? scoped.listWorkflows().map((workflow) => workflow.id)
            : authz
              ? [...authz.grants["run:workflow"]]
              : undefined
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
        const { authz, scoped } = requestAuthState(context)
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
          if (
            !intervention ||
            !canViewWorkflowIntervention(authz, intervention) ||
            (scoped && !scoped.getWorkflowById(intervention.workflowId))
          ) {
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
      async (context) => {
        const { params, body, set } = context
        const { authz, scoped } = requestAuthState(context)
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
          if (
            !intervention ||
            !canViewWorkflowIntervention(authz, intervention) ||
            (scoped && !scoped.getWorkflowById(intervention.workflowId))
          ) {
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
            submittedBy: serializePrincipal(authz?.principal ?? SYSTEM_PRINCIPAL),
          })

          const [job] = await sixb.queues.workflows.enqueue({
            projectId: sixb.id,
            jobs: [
              {
                type: "workflow.run.resume.requested",
                payload: {
                  workflowId: submitted.workflowId,
                  runId: submitted.workflowRunId,
                  resume: { kind: "intervention", interventionId: submitted.id },
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
      async (context) => {
        const { params, body, set } = context
        const { authz, scoped } = requestAuthState(context)
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
          if (
            !intervention ||
            !canViewWorkflowIntervention(authz, intervention) ||
            (scoped && !scoped.getWorkflowById(intervention.workflowId))
          ) {
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

          CancelWorkflowInterventionBodySchema.parse(body ?? {})
          const cancelledAt = new Date()
          const { cancelled, cancelledNode, cancelledRun } = await sixb.storage.transaction(
            async (tx) => {
              if (!tx.workflowInterventions || !tx.workflowRuns) {
                throw new Error("[SixbServer] Workflow storage disappeared during cancellation.")
              }
              const cancelled = await tx.workflowInterventions.cancel({
                projectId: sixb.id,
                id: intervention.id,
                cancelledAt,
                cancelledBy: serializePrincipal(authz?.principal ?? SYSTEM_PRINCIPAL),
              })
              const cancelledNode = await tx.workflowRuns.nodes.finish({
                projectId: sixb.id,
                id: intervention.nodeRunId,
                status: "cancelled",
                finishedAt: cancelledAt,
                error: "Workflow intervention cancelled.",
              })
              const cancelledRun = await tx.workflowRuns.finish({
                projectId: sixb.id,
                id: intervention.workflowRunId,
                status: "cancelled",
                finishedAt: cancelledAt,
                error: "Workflow intervention cancelled.",
              })
              return { cancelled, cancelledNode, cancelledRun }
            }
          )

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
        const { authz, scoped } = requestAuthState(context)
        try {
          const parsed = WorkflowRunsQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const storage = sixb.storage.workflowRuns
          if (!storage) {
            return { runs: [], hasMore: false, total: 0 }
          }

          const workflowIds = scoped
            ? scoped.listWorkflows().map((workflow) => workflow.id)
            : authz
              ? [...authz.grants["run:workflow"]]
              : undefined
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
        const { authz, scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.workflowRuns
          if (!storage) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }

          const run = await storage.getById({ projectId: sixb.id, id: params.runId })
          if (!run || !canAccessWorkflowRun(authz, scoped, run)) {
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
            nodes: await Promise.all(
              nodes.nodes.map((node) => serializeWorkflowNodeWithExecution(storage, node))
            ),
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
      "/api/workflow-runs/:runId/nodes/:nodeKey/agent-execution",
      async (context) => {
        const { params, set } = context
        const { authz, scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.workflowRuns
          if (!storage) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }
          const run = await storage.getById({ projectId: sixb.id, id: params.runId })
          if (!run || !canAccessWorkflowRun(authz, scoped, run)) {
            set.status = 404
            return { error: "Workflow agent execution not found" }
          }
          const listed = await storage.nodes.list({
            projectId: sixb.id,
            workflowRunId: run.id,
            nodeKey: params.nodeKey,
            limit: 1,
            order: "asc",
          })
          const node = listed.nodes[0]
          if (!node || node.nodeType !== "agent") {
            set.status = 404
            return { error: "Workflow agent execution not found" }
          }
          const execution = await storage.agentNodes.getByNodeRunId({
            projectId: sixb.id,
            nodeRunId: node.id,
          })
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
        const { authz, scoped } = requestAuthState(context)
        try {
          CancelWorkflowRunBodySchema.parse(body ?? {})
          const storage = sixb.storage.workflowRuns
          if (!storage) {
            set.status = 400
            return { error: "Workflow run storage is not configured" }
          }
          const existing = await storage.getById({ projectId: sixb.id, id: params.runId })
          if (!existing || !canAccessWorkflowRun(authz, scoped, existing)) {
            set.status = 404
            return { error: "Workflow run not found" }
          }
          const workflow = sixb.workflows.getById(existing.workflowId)
          if (!workflow) {
            set.status = 404
            return { error: "Workflow not found" }
          }
          const listed = await storage.nodes.list({
            projectId: sixb.id,
            workflowRunId: existing.id,
            order: "asc",
          })
          if (existing.status === "cancelled") {
            return CancelWorkflowRunResponseSchema.parse({
              run: serializeWorkflowRun(existing),
              nodes: await Promise.all(
                listed.nodes.map((node) => serializeWorkflowNodeWithExecution(storage, node))
              ),
            })
          }
          if (existing.status === "succeeded" || existing.status === "failed") {
            set.status = 400
            return { error: `Workflow run is already ${existing.status}` }
          }

          const cancelledAt = new Date()
          const cancellationError = "Workflow run cancelled."
          const result = await sixb.storage.transaction(async (tx) => {
            const runs = tx.workflowRuns
            if (!runs) {
              throw new Error("[SixbServer] Workflow storage disappeared during cancellation.")
            }
            const run = await runs.getById({ projectId: sixb.id, id: existing.id })
            if (!run || !["queued", "running", "waiting"].includes(run.status)) {
              throw new Error(`[SixbServer] Workflow run '${existing.id}' is no longer active.`)
            }
            const active = [...listed.nodes]
              .reverse()
              .find((node) => node.status === "running" || node.status === "waiting")
            let cancelledNode: WorkflowNodeRunRecord | undefined
            if (active?.nodeType === "agent") {
              const execution = await runs.agentNodes.getByNodeRunId({
                projectId: sixb.id,
                nodeRunId: active.id,
              })
              if (execution?.status === "queued" || execution?.status === "running") {
                await runs.agentNodes.cancel({
                  projectId: sixb.id,
                  nodeRunId: active.id,
                  completedAt: cancelledAt,
                  error: cancellationError,
                })
              }
            }
            if (active?.nodeType === "intervention" && tx.workflowInterventions) {
              const pending = await tx.workflowInterventions.list({
                projectId: sixb.id,
                workflowRunId: run.id,
                nodeRunId: active.id,
                statuses: ["pending"],
                limit: 1,
              })
              const intervention = pending.interventions[0]
              if (intervention) {
                await tx.workflowInterventions.cancel({
                  projectId: sixb.id,
                  id: intervention.id,
                  cancelledAt,
                  cancelledBy: serializePrincipal(authz?.principal ?? SYSTEM_PRINCIPAL),
                })
              }
            }
            if (active) {
              cancelledNode = await runs.nodes.finish({
                projectId: sixb.id,
                id: active.id,
                status: "cancelled",
                finishedAt: cancelledAt,
                error: cancellationError,
                executionToken: run.execution?.token,
              })
            }
            const cancelledRun = await runs.finish({
              projectId: sixb.id,
              id: run.id,
              status: "cancelled",
              finishedAt: cancelledAt,
              error: cancellationError,
              executionToken: run.execution?.token,
            })
            return { run: cancelledRun, node: cancelledNode }
          })

          await emitWorkflowRunCancelled({ sixb, workflow, ...result })
          if (result.node?.nodeType === "agent") {
            await publishAgentRunCancel(sixb.broker, {
              projectId: sixb.id,
              runId: result.node.id,
            }).catch((error) => {
              console.error(
                `[SixbServer] Could not signal cancellation for workflow agent node '${result.node?.id}'.`,
                error
              )
            })
          }
          const nodes = await storage.nodes.list({
            projectId: sixb.id,
            workflowRunId: existing.id,
            order: "asc",
          })
          return CancelWorkflowRunResponseSchema.parse({
            run: serializeWorkflowRun(result.run),
            nodes: await Promise.all(
              nodes.nodes.map((node) => serializeWorkflowNodeWithExecution(storage, node))
            ),
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
