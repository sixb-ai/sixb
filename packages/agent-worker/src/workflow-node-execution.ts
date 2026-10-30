import {
  type AgentExecutionEnvironment,
  AgentTurnTimeoutError,
  createWorkflowAgentNodeEnvironment,
  isLostExecution,
  listSandboxModels,
  prepareAgentModel,
  resolveWorkflowAgentStepExecutionPlan,
  runWorkflowAgentNode,
  toAgentExecutionFailure,
  type WorkflowAgentFailurePhase,
  WorkflowAgentNodeExecutionError,
} from "@sixb/agent"
import type { AgentMessagePart, SixbFailure, ValueType, WorkflowDefinition } from "@sixb/core"
import { bindAgentModelExecution } from "@sixb/core/internal/agent-execution"
import {
  claimWorkflowAgentNode,
  enqueueWorkflowAgentNodeResume,
  type WorkflowAgentNodeSession,
  WorkflowResumeDispatchError,
} from "@sixb/core/internal/agents"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import {
  createSixbError,
  isSixbError,
  summarizeErrorMessage,
  toSixbFailure,
  withFailureMessage,
} from "@sixb/core/internal/errors"
import {
  type AiModelCallRecorder,
  ModelUsageRecordingError,
} from "@sixb/core/internal/model-execution"
import type { QueueDelivery } from "@sixb/core/internal/workers"
import type { WorkflowAgentNodeDefinition } from "@sixb/core/internal/workflows"
import { createWorkflowNodeFailure, workflowAgentStepActorId } from "@sixb/core/internal/workflows"
import type {
  AgentQueueJob,
  AgentQueueJobFailureCode,
  AgentWorkflowNodeRequestedQueueJob,
} from "@sixb/core/queues"
import type {
  AgentRunFinishReason,
  ExecutionRecord,
  ReadonlyJsonObject,
  WorkflowAgentNodeRunRecord,
  WorkflowNodeRunRecord,
  WorkflowRunFailureCode,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { AGENT_RUN_FAILURE_CODES, WORKFLOW_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { shouldRetryAgentPreparation } from "./delivery-policy"
import { createAgentExecutionContext } from "./execution-context"
import { workflowStepSandbox } from "./run-sandboxes"
import type { AgentWorkerContext, AgentWorkerHost } from "./types"

export interface ExecuteWorkflowAgentNodeInput {
  readonly context: AgentWorkerContext
  readonly host: AgentWorkerHost
  readonly job: AgentWorkflowNodeRequestedQueueJob
  readonly signal: AbortSignal
  readonly delivery: QueueDelivery<AgentQueueJob, AgentQueueJobFailureCode>
  readonly onDetachedTeardown: (teardown: Promise<void>) => void
}

interface WorkflowAgentNodeRecords {
  readonly runs: WorkflowRunStorage
  readonly executionRecord: WorkflowAgentNodeRunRecord
  readonly nodeRun: WorkflowNodeRunRecord
  readonly workflowRun: WorkflowRunRecord
}

interface WorkflowAgentNodeExecutionContext extends WorkflowAgentNodeRecords {
  readonly workflow: WorkflowDefinition
  readonly node: WorkflowAgentNodeDefinition
  readonly actorId: string
  readonly durableExecution: ExecutionRecord
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}

export async function executeWorkflowAgentNode(
  input: ExecuteWorkflowAgentNodeInput
): Promise<void> {
  const loaded = await loadWorkflowAgentNodeExecution(input)
  if (!loaded) return

  const { context, job, signal, delivery } = input
  const { executionRecord, nodeRun } = loaded
  // Preparation belongs to the owned attempt too, so failures can durably finish the task and
  // its workflow without claiming a second token in the failure handler.
  const session = await claimWorkflowAgentNode(
    {
      projectId: context.id,
      storage: context.storage,
      broker: input.host.broker,
      recoverAiModelCall: context.recoverAiModelCall,
      events: input.host.events,
      workflowQueue: input.host.queues.workflows,
      security: input.host.definitions.security,
    },
    { node: executionRecord, nodeRun, leaseExpiresAt: delivery.leaseExpiresAt }
  )
  const reserved = session.node
  let usageRecorder: AiModelCallRecorder | undefined

  let environment: AgentExecutionEnvironment | null = null
  let modelId = reserved.modelId
  let totalNodes: number | undefined
  let preparationComplete = false
  const turnSignal = AbortSignal.any([signal, session.cancelled])
  // Fires only when the node's time budget elapses: its environment, model loop and tools stop.
  const deadline = new AbortController()
  // Fires when the node ends, however it ends: its tools' model calls must not outlive it.
  const ended = new AbortController()
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const stopOwnershipProjection = delivery.onLeaseRenewed((renewed) => {
    void session.renewLease(renewed.leaseExpiresAt).catch(() => {})
  })

  try {
    await session.renewLease(delivery.leaseExpiresAt)
    const { workflow, node, actorId, durableExecution, valueTypesById } =
      await resolveWorkflowAgentNodeExecution(input, loaded, session)
    usageRecorder = await session.modelCalls()
    totalNodes = workflow.nodes.length
    const configuredPlan = resolveWorkflowAgentStepExecutionPlan({
      workflowId: workflow.id,
      step: node.agentStep,
      models: input.host.definitions.models?.language,
      tools: input.host.definitions.tools,
      skills: input.host.definitions.agent.skills,
      defaultMaxSteps: context.defaultMaxSteps,
      sandboxModels: listSandboxModels(input.host.definitions.models),
    })
    modelId = configuredPlan.model.modelId
    const resolved = await session.authorizeActor(actorId, durableExecution.authorizationRef)
    const executionContext = await createAgentExecutionContext({
      context,
      host: input.host,
      execution: durableExecution,
      actorId,
      runId: nodeRun.id,
      people: session.people,
      authorization: { type: "principal", context: resolved.context },
      authorPrincipal: resolved.identity.principal,
    })
    const prepared = await prepareAgentModel(configuredPlan)
    const plan = Object.freeze({ ...configuredPlan, model: prepared.model })
    preparationComplete = true

    // The deadline starts before the environment: preparing it shares the node's time budget.
    // Its reason is the node's failure, also when the abort makes provisioning fail.
    deadlineTimer = setTimeout(
      () => deadline.abort(nodeDeadlineExceeded(nodeRun.id, context.turnTimeoutMs)),
      context.turnTimeoutMs
    )

    // Provisioning stops on cancellation, lost ownership, worker shutdown (the delivery `signal`)
    // or the deadline, never because the node finished: a sandbox still booting then reaches the
    // normal destroy once it is ready.
    const provisioningSignal = AbortSignal.any([turnSignal, deadline.signal])
    const nodeSignal = AbortSignal.any([provisioningSignal, ended.signal])
    environment = await createWorkflowAgentNodeEnvironment({
      openSandbox: workflowStepSandbox({
        context,
        session,
        run: reserved,
        ...(node.agentStep.sandbox === undefined ? {} : { stepSandbox: node.agentStep.sandbox }),
      }),
      context: executionContext,
      plan,
      run: reserved,
      workflowId: workflow.id,
      stepId: node.agentStep.id,
      nodeInput: nodeRun.input,
      errorDetails: workflowAgentErrorDetails(nodeRun),
      signal: provisioningSignal,
      onDetachedTeardown: input.onDetachedTeardown,
    })
    bindAgentModelExecution(executionContext.sixb, {
      signal: nodeSignal,
      accounting: usageRecorder,
    })
    const result = await runWorkflowAgentNode({
      context: environment.turnContext,
      agentStepId: node.agentStep.id,
      plan,
      agentStep: node.agentStep,
      workflowId: workflow.id,
      workflowRunId: nodeRun.workflowRunId,
      nodeRunId: nodeRun.id,
      prompt: reserved.prompt,
      createdAt: reserved.createdAt,
      valueTypesById,
      usageRecorder,
      signal: nodeSignal,
    })

    await environment.beforeFinalize()
    await session.finishSucceeded({
      modelId: result.modelId,
      finishReason: result.finishReason,
      trace: result.trace,
      output: result.output,
      totalNodes: workflow.nodes.length,
    })
  } catch (error) {
    if (error instanceof WorkflowResumeDispatchError) throw error
    // Queue ownership or the node's execution token was lost: the current owner records the fate.
    if (isLostExecution(error, signal)) return

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
    // Accounting failure takes precedence so no later billable model call can start.
    let executionError = debug?.cause ?? error
    let failurePhase = debug?.phase
    try {
      usageRecorder?.assertHealthy()
    } catch (recordingError) {
      const sameAdmissionFailure =
        isAiUsageLimitFailure(executionError) && isAiUsageLimitFailure(recordingError)
      executionError = recordingError
      if (!sameAdmissionFailure) failurePhase = undefined
    }

    if (signal.aborted) throw executionError
    if (
      !preparationComplete &&
      !session.cancelled.aborted &&
      shouldRetryAgentPreparation(executionError, job.attempt)
    ) {
      throw executionError
    }
    if (session.cancelled.aborted && (await session.wasCancelled())) {
      // The cancellation endpoint has already made the execution terminal, so it cannot be fenced
      // again. Still surface an accounting failure instead of silently acknowledging it.
      if (executionError instanceof ModelUsageRecordingError) throw executionError
      return
    }

    const status =
      session.cancelled.aborted && !(executionError instanceof ModelUsageRecordingError)
        ? "cancelled"
        : "failed"
    await environment?.beforeFinalize()
    const failed = await finishWorkflowAgentNodeFailed({
      session,
      nodeRun,
      agentStepId: nodeRun.nodeId,
      modelId,
      totalNodes,
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
  } finally {
    clearTimeout(deadlineTimer)
    ended.abort()
    stopOwnershipProjection()
    session.close()
    await environment?.dispose()
  }
}

async function loadWorkflowAgentNodeExecution(
  input: ExecuteWorkflowAgentNodeInput
): Promise<WorkflowAgentNodeRecords | null> {
  const { context, job } = input
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
  // A delivery that outlived the node's success only owes the workflow its resume.
  if (executionRecord.status === "succeeded") {
    await enqueueWorkflowAgentNodeResume(
      { projectId: context.id, workflowQueue: input.host.queues.workflows },
      nodeRun
    )
    return null
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
            agentStepId: nodeRun.nodeId,
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

  return { runs, executionRecord, nodeRun, workflowRun }
}

async function resolveWorkflowAgentNodeExecution(
  input: ExecuteWorkflowAgentNodeInput,
  loaded: WorkflowAgentNodeRecords,
  session: Pick<WorkflowAgentNodeSession, "execution">
): Promise<WorkflowAgentNodeExecutionContext> {
  const { host, job } = input
  const { runs, executionRecord, nodeRun, workflowRun } = loaded
  const durableExecution = await session.execution()
  if (!durableExecution) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent workflow node '${nodeRun.id}' references missing execution '${executionRecord.executionId}'.`,
      {
        details: {
          ...workflowAgentErrorDetails(nodeRun),
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
          ...workflowAgentErrorDetails(nodeRun),
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
      { details: workflowAgentErrorDetails(nodeRun) }
    )
  }
  const actorId = workflowAgentStepActorId(workflow.id, node.agentStep.id)
  if (executionRecord.actorId !== actorId) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Workflow agent step '${node.agentStep.id}' execution identity does not match its definition.`,
      { details: workflowAgentErrorDetails(nodeRun) }
    )
  }

  return {
    runs,
    executionRecord,
    nodeRun,
    workflowRun,
    workflow,
    node,
    actorId,
    durableExecution,
    valueTypesById: host.definitions.ontology.getValueTypesById(),
  }
}

async function finishWorkflowAgentNodeFailed(input: {
  readonly session: WorkflowAgentNodeSession
  readonly nodeRun: WorkflowNodeRunRecord
  readonly agentStepId: string
  readonly modelId?: string
  /** The workflow's node count; absent when its definition is gone. */
  readonly totalNodes?: number
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
    ...workflowAgentErrorDetails(input.nodeRun),
    ...(input.failurePhase === undefined ? {} : { failurePhase: input.failurePhase }),
  }
  const agentExecutionError =
    input.failurePhase === undefined
      ? input.error
      : attachWorkflowAgentFailureDetails(input.error, input.status, agentErrorDetails)
  const workflowFailureError =
    input.status === "failed"
      ? isAiUsageLimitFailure(agentExecutionError)
        ? agentExecutionError
        : createWorkflowNodeFailure(input.error, {
            workflowId: input.nodeRun.workflowId,
            workflowRunId: input.nodeRun.workflowRunId,
            nodeId: input.nodeRun.nodeId,
            nodeRunId: input.nodeRun.id,
            failurePhase: input.failurePhase,
            modelId: input.modelId,
            child: { type: "agent", agentStepId: input.agentStepId },
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
  const finished = await input.session.finishFailed({
    status: input.status,
    at,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
    ...(input.trace === undefined ? {} : { trace: input.trace }),
    agentError: toAgentExecutionFailure(agentExecutionError, {
      status: input.status,
      at,
      details: agentErrorDetails,
    }),
    workflowError: workflowFailure,
    ...(input.totalNodes === undefined ? {} : { totalNodes: input.totalNodes }),
  })
  return { ...finished, failure: workflowFailure }
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
    (error.code === "internal.unexpected" ||
      error.code === "agent.execution_failed" ||
      error.code === "ai.usage_limit_exceeded" ||
      error.code === "ai.usage_limit_unavailable")
  ) {
    const errorDetails =
      (error.code === "ai.usage_limit_exceeded" || error.code === "ai.usage_limit_unavailable") &&
      typeof error.details === "object" &&
      error.details !== null &&
      !Array.isArray(error.details)
        ? { ...(error.details as ReadonlyJsonObject), ...details }
        : details
    return createSixbError(error.code, error.message, { cause: error, details: errorDetails })
  }
  return error
}

function isAiUsageLimitFailure(error: unknown): error is ReturnType<typeof createSixbError> {
  return (
    isSixbError(error) &&
    (error.code === "ai.usage_limit_exceeded" || error.code === "ai.usage_limit_unavailable")
  )
}

/** The node's time budget elapsed. The recorded failure names the worker setting that sets it. */
function nodeDeadlineExceeded(nodeRunId: string, timeoutMs: number): AgentTurnTimeoutError {
  return withFailureMessage(
    new AgentTurnTimeoutError(nodeRunId, timeoutMs),
    `The task did not finish within the agent worker's turn budget (turnTimeoutMs: ${timeoutMs}).`
  )
}

interface WorkflowAgentErrorDetails extends Readonly<Record<string, string>> {
  readonly agentStepId: string
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId: string
}

function workflowAgentErrorDetails(
  nodeRun: Pick<WorkflowNodeRunRecord, "id" | "workflowId" | "workflowRunId" | "nodeId">
): WorkflowAgentErrorDetails {
  return {
    agentStepId: nodeRun.nodeId,
    workflowId: nodeRun.workflowId,
    workflowRunId: nodeRun.workflowRunId,
    nodeId: nodeRun.nodeId,
    nodeRunId: nodeRun.id,
  }
}
