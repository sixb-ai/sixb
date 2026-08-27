import type {
  AgentDefinition,
  AgentMessagePart,
  SixbFailure,
  ValueType,
  WorkflowDefinition,
} from "@sixb/core"
import {
  createAgentRunExecutionToken,
  resolveAgentExecutionAuthorization,
} from "@sixb/core/internal/agents"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import {
  createSixbError,
  isSixbError,
  summarizeErrorMessage,
  toSixbFailure,
} from "@sixb/core/internal/errors"
import type { QueueDelivery } from "@sixb/core/internal/workers"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { WorkflowAgentNodeDefinition } from "@sixb/core/internal/workflows"
import { createWorkflowNodeFailure } from "@sixb/core/internal/workflows"
import type {
  AgentQueueJob,
  AgentQueueJobFailureCode,
  AgentWorkflowNodeRequestedQueueJob,
} from "@sixb/core/queues"
import type {
  AgentRunFinishReason,
  ExecutionRecord,
  WorkflowAgentNodeRunExecution,
  WorkflowAgentNodeRunRecord,
  WorkflowNodeRunRecord,
  WorkflowRunFailureCode,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { AGENT_RUN_FAILURE_CODES, WORKFLOW_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { AgentUsageRecordingError } from "./errors"
import { createAgentExecutionContext } from "./execution-context"
import { toAgentExecutionFailure } from "./failure"
import { AiModelCallRecorder } from "./model-call-recorder"
import {
  type AgentExecutionEnvironment,
  createWorkflowAgentNodeEnvironment,
} from "./run-environment"
import {
  runWorkflowAgentNode,
  type WorkflowAgentFailurePhase,
  WorkflowAgentNodeExecutionError,
} from "./run-workflow-agent-node"
import type { AgentWorkerContext, AgentWorkerHost } from "./types"

export interface ExecuteWorkflowAgentNodeInput {
  readonly context: AgentWorkerContext
  readonly host: AgentWorkerHost
  readonly job: AgentWorkflowNodeRequestedQueueJob
  readonly signal: AbortSignal
  readonly delivery: QueueDelivery<AgentQueueJob, AgentQueueJobFailureCode>
  readonly watchForCancel: (runId: string) => Promise<{
    readonly signal: AbortSignal
    readonly stop: () => void
  }>
  readonly onDetachedTeardown: (teardown: Promise<void>) => void
}

interface WorkflowAgentNodeExecutionContext {
  readonly runs: WorkflowRunStorage
  readonly executionRecord: WorkflowAgentNodeRunRecord
  readonly nodeRun: WorkflowNodeRunRecord
  readonly workflowRun: WorkflowRunRecord
  readonly workflow: WorkflowDefinition
  readonly node: WorkflowAgentNodeDefinition
  readonly agent: AgentDefinition
  readonly durableExecution: ExecutionRecord
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}

export async function executeWorkflowAgentNode(
  input: ExecuteWorkflowAgentNodeInput
): Promise<void> {
  const loaded = await loadWorkflowAgentNodeExecution(input)
  if (!loaded) return

  const { context, job, signal, delivery } = input
  const {
    runs,
    executionRecord,
    nodeRun,
    workflowRun,
    workflow,
    node,
    agent,
    durableExecution,
    valueTypesById,
  } = loaded
  const resolved = await resolveAgentExecutionAuthorization({
    auth: context.storage.auth,
    projectId: context.id,
    agentId: agent.id,
    authorizationRef: durableExecution.authorizationRef,
    security: input.host.definitions.security,
  })
  const executionContext = createAgentExecutionContext({
    context,
    host: input.host,
    execution: durableExecution,
    agentId: agent.id,
    runId: nodeRun.id,
    authorization: resolved.context,
    agentPrincipal: resolved.identity.principal,
  })
  const reserved = await reserveWorkflowAgentNode({
    runs,
    executionRecord,
    nodeRun,
    agent,
    execution: freshWorkflowExecution(delivery.leaseExpiresAt),
  })
  const executionToken = reserved.execution?.token
  if (!executionToken) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent workflow node '${nodeRun.id}' has no execution token.`,
      { details: workflowAgentErrorDetails(agent.id, nodeRun) }
    )
  }
  const usageRecorder = new AiModelCallRecorder({
    storage: context.storage.aiUsage,
    projectId: context.id,
    executionId: executionRecord.executionId,
    attempt: reserved.attempt,
    requesterGroupIds: workflowRun.requesterGroupIds,
    recoverAiModelCall: context.recoverAiModelCall,
    errorRunId: nodeRun.id,
  })

  let environment: AgentExecutionEnvironment | null = null
  const cancel = await input.watchForCancel(nodeRun.id)
  const stopOwnershipProjection = projectQueueOwnership({
    delivery,
    runs,
    projectId: context.id,
    nodeRunId: nodeRun.id,
    executionToken,
  })

  try {
    await confirmQueueOwnership({
      runs,
      projectId: context.id,
      nodeRunId: nodeRun.id,
      executionToken,
      queueLeaseExpiresAt: delivery.leaseExpiresAt,
    })
    environment = await createWorkflowAgentNodeEnvironment({
      context: executionContext,
      agent,
      run: reserved,
      nodeInput: nodeRun.input,
      onDetachedTeardown: input.onDetachedTeardown,
    })
    const result = await runWorkflowAgentNode({
      context: environment.turnContext,
      agent,
      agentStep: node.agentStep,
      workflowId: workflow.id,
      workflowRunId: nodeRun.workflowRunId,
      nodeRunId: nodeRun.id,
      prompt: reserved.prompt,
      valueTypesById,
      usageRecorder,
      signal: AbortSignal.any([signal, cancel.signal]),
    })
    const completedNode = await finishWorkflowAgentNodeSucceeded({
      context,
      nodeRun,
      agentId: agent.id,
      executionToken,
      result,
    })
    await emitNodeSucceeded(input.host, completedNode, workflow.nodes.length)
    await enqueueWorkflowAgentNodeResume(input.host, nodeRun).catch((error) => {
      console.error(
        `[SixbAgentWorker] Could not resume workflow after agent node '${nodeRun.id}'; the dispatcher will retry.`,
        error
      )
    })
  } catch (error) {
    if (lostQueueDelivery(error, signal)) return

    const debug =
      error instanceof WorkflowAgentNodeExecutionError
        ? {
            cause: error.cause,
            phase: error.phase,
            finishReason: error.finishReason,
            trace: error.trace,
          }
        : undefined

    // Output parsing and tool handling can fail after the final provider callback. Accounting
    // failure takes precedence because AI SDK otherwise swallows the callback error.
    let executionError = debug?.cause ?? error
    let failurePhase = debug?.phase
    try {
      usageRecorder.assertHealthy()
    } catch (recordingError) {
      executionError = recordingError
      failurePhase = undefined
    }

    if (signal.aborted) throw executionError
    if (cancel.signal.aborted && (await isAlreadyCancelled(runs, context.id, nodeRun.id))) {
      // The cancellation endpoint has already made the execution terminal, so it cannot be fenced
      // again. Still surface an accounting failure instead of silently acknowledging it.
      if (executionError instanceof AgentUsageRecordingError) throw executionError
      return
    }

    const status =
      cancel.signal.aborted && !(executionError instanceof AgentUsageRecordingError)
        ? "cancelled"
        : "failed"
    const failed = await finishWorkflowAgentNodeFailed({
      context,
      nodeRun,
      agent,
      executionToken,
      status,
      error: executionError,
      trace: debug?.trace,
      finishReason: debug?.finishReason,
      failurePhase,
    })
    if (status === "failed") {
      reportRunFailure(input.host, executionError, {
        projectId: context.id,
        attempt: job.attempt,
        runKind: "workflow",
        run: {
          runId: failed.run.id,
          workflowId: failed.run.workflowId,
        },
        failure: failed.failure,
      })
    }
    await emitNodeAndRunFailed(input.host, failed, workflow.nodes.length, status)
  } finally {
    stopOwnershipProjection()
    cancel.stop()
    await environment?.dispose()
  }
}

async function loadWorkflowAgentNodeExecution(
  input: ExecuteWorkflowAgentNodeInput
): Promise<WorkflowAgentNodeExecutionContext | null> {
  const { context, host, job } = input
  const runs = context.storage.workflowRuns
  if (!runs) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Workflow agent nodes require workflow storage.",
      { details: { nodeRunId: job.payload.nodeRunId } }
    )
  }

  const [executionRecord, nodeRun] = await Promise.all([
    runs.agentNodes.getByNodeRunId({
      projectId: context.id,
      nodeRunId: job.payload.nodeRunId,
    }),
    runs.nodes.getById({ projectId: context.id, id: job.payload.nodeRunId }),
  ])
  if (!executionRecord || !nodeRun || nodeRun.nodeType !== "agent") {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent workflow node '${job.payload.nodeRunId}' was not found.`,
      { details: { nodeRunId: job.payload.nodeRunId } }
    )
  }
  if (executionRecord.status !== "queued" && executionRecord.status !== "running") return null

  const workflowRun = await runs.getById({ projectId: context.id, id: nodeRun.workflowRunId })
  if (!workflowRun || workflowRun.status !== "waiting" || nodeRun.status !== "waiting") {
    const completedAt = new Date()
    const message = workflowRun
      ? `Parent workflow run is ${workflowRun.status}.`
      : "Parent workflow run is missing."
    await runs.agentNodes.cancel({
      projectId: context.id,
      nodeRunId: nodeRun.id,
      error: toSixbFailure(
        createSixbError("runtime.cancelled", message, {
          details: {
            agentId: executionRecord.agentId,
            workflowId: nodeRun.workflowId,
            workflowRunId: nodeRun.workflowRunId,
            nodeRunId: nodeRun.id,
          },
        }),
        {
          allowedCodes: AGENT_RUN_FAILURE_CODES,
          at: completedAt,
        }
      ),
      completedAt,
    })
    return null
  }

  const durableExecution = await context.storage.executions.getById({
    projectId: context.id,
    id: executionRecord.executionId,
  })
  if (!durableExecution) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent workflow node '${nodeRun.id}' references missing execution '${executionRecord.executionId}'.`,
      {
        details: {
          ...workflowAgentErrorDetails(executionRecord.agentId, nodeRun),
          executionId: executionRecord.executionId,
        },
      }
    )
  }
  if (
    durableExecution.source.type !== "execution" ||
    durableExecution.source.executionId !== workflowRun.executionId
  ) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent workflow node '${nodeRun.id}' execution is not linked to workflow run '${workflowRun.id}'.`,
      {
        details: {
          ...workflowAgentErrorDetails(executionRecord.agentId, nodeRun),
          executionId: executionRecord.executionId,
        },
      }
    )
  }

  const workflow = host.definitions.workflows.getById(nodeRun.workflowId)
  const node = workflow?.nodes[nodeRun.nodeIndex]
  if (!workflow || !node || node.type !== "agent" || node.id !== nodeRun.nodeId) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Workflow definition for agent node '${job.payload.nodeRunId}' is no longer available.`,
      { details: workflowAgentErrorDetails(executionRecord.agentId, nodeRun) }
    )
  }
  const agent = host.definitions.agents.getById(executionRecord.agentId)
  if (!agent || agent.id !== node.agentStep.agent.id) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Unknown agent '${executionRecord.agentId}'.`,
      { details: workflowAgentErrorDetails(executionRecord.agentId, nodeRun) }
    )
  }

  return {
    runs,
    executionRecord,
    nodeRun,
    workflowRun,
    workflow,
    node,
    agent,
    durableExecution,
    valueTypesById: host.definitions.ontology.getValueTypesById(),
  }
}

async function reserveWorkflowAgentNode(input: {
  readonly runs: WorkflowRunStorage
  readonly executionRecord: WorkflowAgentNodeRunRecord
  readonly nodeRun: WorkflowNodeRunRecord
  readonly agent: AgentDefinition
  readonly execution: WorkflowAgentNodeRunExecution
}): Promise<WorkflowAgentNodeRunRecord> {
  if (input.executionRecord.status === "queued") {
    return input.runs.agentNodes.start({
      projectId: input.executionRecord.projectId,
      nodeRunId: input.nodeRun.id,
      modelId: input.agent.model.modelId,
      execution: input.execution,
    })
  }
  return input.runs.agentNodes.reclaim({
    projectId: input.executionRecord.projectId,
    nodeRunId: input.nodeRun.id,
    execution: input.execution,
  })
}

function projectQueueOwnership(input: {
  readonly delivery: QueueDelivery<AgentQueueJob, AgentQueueJobFailureCode>
  readonly runs: WorkflowRunStorage
  readonly projectId: string
  readonly nodeRunId: string
  readonly executionToken: string
}): () => void {
  return input.delivery.onLeaseRenewed((renewed) => {
    void confirmQueueOwnership({
      ...input,
      queueLeaseExpiresAt: renewed.leaseExpiresAt,
    }).catch(() => {})
  })
}

function confirmQueueOwnership(input: {
  readonly runs: WorkflowRunStorage
  readonly projectId: string
  readonly nodeRunId: string
  readonly executionToken: string
  readonly queueLeaseExpiresAt: string
}): Promise<WorkflowAgentNodeRunRecord> {
  return input.runs.agentNodes.confirmExecutionOwnership({
    projectId: input.projectId,
    nodeRunId: input.nodeRunId,
    executionToken: input.executionToken,
    queueLeaseExpiresAt: new Date(input.queueLeaseExpiresAt),
  })
}

async function finishWorkflowAgentNodeSucceeded(input: {
  readonly context: AgentWorkerContext
  readonly nodeRun: WorkflowNodeRunRecord
  readonly agentId: string
  readonly executionToken: string
  readonly result: Awaited<ReturnType<typeof runWorkflowAgentNode>>
}): Promise<WorkflowNodeRunRecord> {
  return input.context.storage.transaction(async (tx) => {
    const runs = tx.workflowRuns
    if (!runs) {
      throw createSixbError(
        "internal.unexpected",
        "[SixbAgentWorker] Workflow storage disappeared during finalization.",
        { details: workflowAgentErrorDetails(input.agentId, input.nodeRun) }
      )
    }
    await runs.agentNodes.finish({
      projectId: input.context.id,
      nodeRunId: input.nodeRun.id,
      executionToken: input.executionToken,
      status: "succeeded",
      modelId: input.result.modelId,
      finishReason: input.result.finishReason,
      trace: input.result.trace,
    })
    return runs.nodes.finish({
      projectId: input.context.id,
      id: input.nodeRun.id,
      status: "succeeded",
      output: input.result.output,
    })
  })
}

async function finishWorkflowAgentNodeFailed(input: {
  readonly context: AgentWorkerContext
  readonly nodeRun: WorkflowNodeRunRecord
  readonly agent: AgentDefinition
  readonly executionToken: string
  readonly status: "failed" | "cancelled"
  readonly error: unknown
  readonly finishReason?: AgentRunFinishReason
  readonly trace?: readonly AgentMessagePart[]
  readonly failurePhase?: WorkflowAgentFailurePhase
}): Promise<{
  readonly node: WorkflowNodeRunRecord
  readonly run: WorkflowRunRecord
  readonly failure: SixbFailure<WorkflowRunFailureCode>
}> {
  const at = new Date()
  const agentErrorDetails = {
    ...workflowAgentErrorDetails(input.agent.id, input.nodeRun),
    ...(input.failurePhase === undefined ? {} : { failurePhase: input.failurePhase }),
  }
  const agentExecutionError =
    input.failurePhase === undefined
      ? input.error
      : attachWorkflowAgentFailureDetails(input.error, input.status, agentErrorDetails)
  const workflowFailureError =
    input.status === "failed"
      ? createWorkflowNodeFailure(input.error, {
          workflowId: input.nodeRun.workflowId,
          workflowRunId: input.nodeRun.workflowRunId,
          nodeId: input.nodeRun.nodeId,
          nodeRunId: input.nodeRun.id,
          child: { type: "agent", agentId: input.agent.id },
        })
      : createSixbError(
          "runtime.cancelled",
          summarizeErrorMessage(input.error, "Agent workflow node execution failed."),
          {
            cause: input.error,
            details: agentErrorDetails,
          }
        )
  const workflowFailure = toSixbFailure(workflowFailureError, {
    allowedCodes: WORKFLOW_RUN_FAILURE_CODES,
    at,
  })
  return input.context.storage.transaction(async (tx) => {
    const runs = tx.workflowRuns
    if (!runs) {
      throw createSixbError(
        "internal.unexpected",
        "[SixbAgentWorker] Workflow storage disappeared during finalization.",
        { details: workflowAgentErrorDetails(input.agent.id, input.nodeRun) }
      )
    }
    await runs.agentNodes.finish({
      projectId: input.context.id,
      nodeRunId: input.nodeRun.id,
      executionToken: input.executionToken,
      status: input.status,
      modelId: input.agent.model.modelId,
      finishReason: input.finishReason,
      trace: input.trace,
      error: toAgentExecutionFailure(agentExecutionError, {
        status: input.status,
        at,
        details: agentErrorDetails,
      }),
      completedAt: at,
    })
    const node = await runs.nodes.finish({
      projectId: input.context.id,
      id: input.nodeRun.id,
      status: input.status,
      finishedAt: at,
      error: workflowFailure,
    })
    const run = await runs.finish({
      projectId: input.context.id,
      id: input.nodeRun.workflowRunId,
      status: input.status,
      finishedAt: at,
      error: workflowFailure,
    })
    return { node, run, failure: workflowFailure }
  })
}

function attachWorkflowAgentFailureDetails(
  error: unknown,
  status: "failed" | "cancelled",
  details: Readonly<Record<string, string>>
): unknown {
  if (status === "cancelled") {
    return createSixbError(
      "runtime.cancelled",
      summarizeErrorMessage(error, "Agent workflow node execution was cancelled."),
      { cause: error, details }
    )
  }
  if (
    isSixbError(error) &&
    (error.code === "internal.unexpected" || error.code === "agent.execution_failed")
  ) {
    return createSixbError(error.code, error.message, { cause: error, details })
  }
  return error
}

async function emitNodeSucceeded(
  host: AgentWorkerHost,
  node: WorkflowNodeRunRecord,
  totalNodes: number
): Promise<void> {
  await host.events
    .append({
      events: [
        {
          type: "workflow.run.node.finished",
          payload: {
            workflowId: node.workflowId,
            runId: node.workflowRunId,
            nodeRunId: node.id,
            nodeIndex: node.nodeIndex,
            totalNodes,
            nodeType: "agent",
            nodeId: node.nodeId,
            nodeKey: node.nodeKey,
            status: "succeeded",
            finishedAt: requireFinishedAt(node).toISOString(),
          },
        },
      ],
    })
    .catch((error) => {
      console.error(
        `[SixbAgentWorker] Could not emit completion for workflow agent node '${node.id}'.`,
        error
      )
    })
}

async function emitNodeAndRunFailed(
  host: AgentWorkerHost,
  failed: { readonly node: WorkflowNodeRunRecord; readonly run: WorkflowRunRecord },
  totalNodes: number,
  status: "failed" | "cancelled"
): Promise<void> {
  await host.events
    .append({
      events: [
        {
          type: "workflow.run.node.finished",
          payload: {
            workflowId: failed.node.workflowId,
            runId: failed.node.workflowRunId,
            nodeRunId: failed.node.id,
            nodeIndex: failed.node.nodeIndex,
            totalNodes,
            nodeType: "agent",
            nodeId: failed.node.nodeId,
            nodeKey: failed.node.nodeKey,
            status,
            finishedAt: requireFinishedAt(failed.node).toISOString(),
            ...(failed.node.error ? { error: failed.node.error } : {}),
          },
        },
        {
          type: "workflow.run.finished",
          payload: {
            workflowId: failed.run.workflowId,
            runId: failed.run.id,
            status,
            finishedAt: requireFinishedAt(failed.run).toISOString(),
            ...(failed.run.error ? { error: failed.run.error } : {}),
          },
        },
      ],
    })
    .catch((error) => {
      console.error(
        `[SixbAgentWorker] Could not emit failure for workflow agent node '${failed.node.id}'.`,
        error
      )
    })
}

export async function enqueueWorkflowAgentNodeResume(
  host: AgentWorkerHost,
  node: Pick<WorkflowNodeRunRecord, "id" | "workflowRunId">
): Promise<void> {
  await host.queues.workflows.enqueue({
    projectId: host.id,
    jobs: [
      {
        id: workflowAgentResumeQueueJobId(node.id),
        type: "workflow.run.resume.requested",
        payload: {
          runId: node.workflowRunId,
          nodeRunId: node.id,
        },
      },
    ],
  })
}

function workflowAgentResumeQueueJobId(nodeRunId: string): string {
  return `wfa_resume_${nodeRunId}`
}

function freshWorkflowExecution(queueLeaseExpiresAt: string): WorkflowAgentNodeRunExecution {
  return {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: new Date(queueLeaseExpiresAt),
  }
}

function lostQueueDelivery(error: unknown, signal: AbortSignal): boolean {
  return (
    error instanceof QueueDeliveryLeaseLostError ||
    signal.reason instanceof QueueDeliveryLeaseLostError
  )
}

async function isAlreadyCancelled(
  runs: WorkflowRunStorage,
  projectId: string,
  nodeRunId: string
): Promise<boolean> {
  const current = await runs.agentNodes.getByNodeRunId({ projectId, nodeRunId })
  return current?.status === "cancelled"
}

function requireFinishedAt(
  record: WorkflowNodeRunRecord | WorkflowRunRecord
): NonNullable<typeof record.finishedAt> {
  if (!record.finishedAt) {
    const details: Readonly<Record<string, string>> =
      "workflowRunId" in record
        ? {
            workflowId: record.workflowId,
            workflowRunId: record.workflowRunId,
            nodeRunId: record.id,
          }
        : { workflowId: record.workflowId, workflowRunId: record.id }
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Workflow run record '${record.id}' has no finishedAt.`,
      { details }
    )
  }
  return record.finishedAt
}

function workflowAgentErrorDetails(
  agentId: string,
  nodeRun: Pick<WorkflowNodeRunRecord, "id" | "workflowId" | "workflowRunId" | "nodeId">
): Readonly<Record<string, string>> {
  return {
    agentId,
    workflowId: nodeRun.workflowId,
    workflowRunId: nodeRun.workflowRunId,
    nodeId: nodeRun.nodeId,
    nodeRunId: nodeRun.id,
  }
}
