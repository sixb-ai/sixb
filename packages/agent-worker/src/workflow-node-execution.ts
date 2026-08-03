import type { AgentDefinition, ValueType, WorkflowDefinition } from "@sixb/core"
import { isSixbError, SixbError } from "@sixb/core/errors"
import { createAgentRunExecutionToken } from "@sixb/core/internal/agents"
import { reportBackgroundTaskFailure, reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { QueueDelivery } from "@sixb/core/internal/workers"
import type { WorkflowAgentNodeDefinition } from "@sixb/core/internal/workflows"
import type { AgentQueueJob, AgentWorkflowNodeRequestedQueueJob } from "@sixb/core/queues"
import type {
  WorkflowAgentNodeRunExecution,
  WorkflowAgentNodeRunRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { toSixbFailure } from "@sixb/core/storage"
import { agentWorkerError } from "./errors"
import { reconcileAgentExecutionIdentity } from "./identity"
import {
  type AgentExecutionEnvironment,
  createWorkflowAgentNodeEnvironment,
} from "./run-environment"
import { runWorkflowAgentNode } from "./run-workflow-agent-node"
import type { AgentWorkerContext, AgentWorkerSixb } from "./types"

export interface ExecuteWorkflowAgentNodeInput {
  readonly context: AgentWorkerContext
  readonly sixb: AgentWorkerSixb
  readonly job: AgentWorkflowNodeRequestedQueueJob
  readonly signal: AbortSignal
  readonly delivery: QueueDelivery<AgentQueueJob>
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
  readonly workflow: WorkflowDefinition
  readonly node: WorkflowAgentNodeDefinition
  readonly agent: AgentDefinition
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}

export async function executeWorkflowAgentNode(
  input: ExecuteWorkflowAgentNodeInput
): Promise<void> {
  const loaded = await loadWorkflowAgentNodeExecution(input)
  if (!loaded) return

  const { context, job, signal, delivery } = input
  const { runs, executionRecord, nodeRun, workflow, node, agent, valueTypesById } = loaded
  const identity = await reconcileAgentExecutionIdentity(context.storage, context.id, agent)
  const reserved = await reserveWorkflowAgentNode({
    runs,
    executionRecord,
    nodeRun,
    agent,
    executionPrincipal: identity.principal,
    execution: freshWorkflowExecution(delivery.leaseExpiresAt),
  })
  const executionToken = reserved.execution?.token
  if (!executionToken) {
    throw agentWorkerError(`Agent workflow node '${nodeRun.id}' has no execution token.`)
  }

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
      context,
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
      prompt: reserved.prompt,
      valueTypesById,
      signal: AbortSignal.any([signal, cancel.signal]),
    })
    const completedNode = await finishWorkflowAgentNodeSucceeded({
      context,
      nodeRun,
      executionToken,
      result,
    })
    await emitNodeSucceeded(input.sixb, completedNode, workflow.nodes.length)
    await enqueueWorkflowAgentNodeResume(input.sixb, nodeRun).catch((error) => {
      // The node is recorded as finished; only the resume job is missing, and the agent worker's
      // dispatch loop re-enqueues it. Until it does, the workflow stops here with nothing saying so.
      reportBackgroundTaskFailure(input.sixb, error, {
        projectId: input.sixb.id,
        task: "workflow.resume",
        subject: nodeRun.id,
      })
    })
  } catch (error) {
    if (lostQueueDelivery(error, signal)) return
    if (signal.aborted) throw error
    if (cancel.signal.aborted && (await isAlreadyCancelled(runs, context.id, nodeRun.id))) return

    const status = cancel.signal.aborted ? "cancelled" : "failed"
    const failed = await finishWorkflowAgentNodeFailed({
      context,
      nodeRun,
      agent,
      executionToken,
      status,
      error,
    })
    if (status === "failed") {
      reportRunFailure(input.sixb, error, {
        projectId: context.id,
        failure: failed.run.error ?? toSixbFailure(error, { fallbackCode: "workflow.failed" }),
        occurredAt: failed.run.finishedAt,
        attempt: job.attempt,
        run: {
          kind: "workflow",
          runId: failed.run.id,
          workflowId: failed.run.workflowId,
        },
      })
    }
    await emitNodeAndRunFailed(input.sixb, failed, workflow.nodes.length, status)
  } finally {
    stopOwnershipProjection()
    cancel.stop()
    await environment?.dispose()
  }
}

async function loadWorkflowAgentNodeExecution(
  input: ExecuteWorkflowAgentNodeInput
): Promise<WorkflowAgentNodeExecutionContext | null> {
  const { context, job, sixb } = input
  const runs = context.storage.workflowRuns
  if (!runs) throw agentWorkerError("Workflow agent nodes require workflow storage.")

  const [executionRecord, nodeRun] = await Promise.all([
    runs.agentNodes.getByNodeRunId({
      projectId: context.id,
      nodeRunId: job.payload.nodeRunId,
    }),
    runs.nodes.getById({ projectId: context.id, id: job.payload.nodeRunId }),
  ])
  if (!executionRecord || !nodeRun || nodeRun.nodeType !== "agent") {
    throw agentWorkerError(`Agent workflow node '${job.payload.nodeRunId}' was not found.`)
  }
  if (executionRecord.agentId !== job.payload.agentId) {
    throw agentWorkerError(
      `Agent workflow node '${job.payload.nodeRunId}' does not match its queued request.`
    )
  }
  if (executionRecord.status !== "queued" && executionRecord.status !== "running") return null

  const workflowRun = await runs.getById({ projectId: context.id, id: nodeRun.workflowRunId })
  if (!workflowRun || workflowRun.status !== "waiting" || nodeRun.status !== "waiting") {
    await runs.agentNodes.cancel({
      projectId: context.id,
      nodeRunId: nodeRun.id,
      error: toSixbFailure(
        new SixbError(
          "runtime.cancelled",
          workflowRun
            ? `Parent workflow run is ${workflowRun.status}.`
            : "Parent workflow run is missing."
        )
      ),
    })
    return null
  }

  if (!sixb.workflows || !sixb.ontology) {
    throw agentWorkerError("Workflow agent nodes require registered workflow definitions.")
  }
  const workflow = sixb.workflows.getById(nodeRun.workflowId)
  const node = workflow?.nodes[nodeRun.nodeIndex]
  if (!workflow || !node || node.type !== "agent" || node.id !== nodeRun.nodeId) {
    throw agentWorkerError(
      `Workflow definition for agent node '${job.payload.nodeRunId}' is no longer available.`
    )
  }
  const agent = sixb.agents.getById(job.payload.agentId)
  if (!agent || agent.id !== node.agentStep.agent.id) {
    throw agentWorkerError(`Unknown agent '${job.payload.agentId}'.`)
  }

  return {
    runs,
    executionRecord,
    nodeRun,
    workflow,
    node,
    agent,
    valueTypesById: sixb.ontology.getValueTypesById(),
  }
}

async function reserveWorkflowAgentNode(input: {
  readonly runs: WorkflowRunStorage
  readonly executionRecord: WorkflowAgentNodeRunRecord
  readonly nodeRun: WorkflowNodeRunRecord
  readonly agent: AgentDefinition
  readonly executionPrincipal: NonNullable<WorkflowAgentNodeRunRecord["executionPrincipal"]>
  readonly execution: WorkflowAgentNodeRunExecution
}): Promise<WorkflowAgentNodeRunRecord> {
  if (input.executionRecord.status === "queued") {
    return input.runs.agentNodes.start({
      projectId: input.executionRecord.projectId,
      nodeRunId: input.nodeRun.id,
      executionPrincipal: input.executionPrincipal,
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
  readonly delivery: QueueDelivery<AgentQueueJob>
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
  readonly executionToken: string
  readonly result: Awaited<ReturnType<typeof runWorkflowAgentNode>>
}): Promise<WorkflowNodeRunRecord> {
  return input.context.storage.transaction(async (tx) => {
    const runs = tx.workflowRuns
    if (!runs) throw agentWorkerError("Workflow storage disappeared during finalization.")
    await runs.agentNodes.finish({
      projectId: input.context.id,
      nodeRunId: input.nodeRun.id,
      executionToken: input.executionToken,
      status: "succeeded",
      modelId: input.result.modelId,
      finishReason: input.result.finishReason,
      usage: input.result.usage,
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
}): Promise<{ readonly node: WorkflowNodeRunRecord; readonly run: WorkflowRunRecord }> {
  const failure = toSixbFailure(input.error, { fallbackCode: "agent.failed" })
  return input.context.storage.transaction(async (tx) => {
    const runs = tx.workflowRuns
    if (!runs) throw agentWorkerError("Workflow storage disappeared during finalization.")
    await runs.agentNodes.finish({
      projectId: input.context.id,
      nodeRunId: input.nodeRun.id,
      executionToken: input.executionToken,
      status: input.status,
      modelId: input.agent.model.modelId,
      error: failure,
    })
    const node = await runs.nodes.finish({
      projectId: input.context.id,
      id: input.nodeRun.id,
      status: input.status,
      error: failure,
    })
    const run = await runs.finish({
      projectId: input.context.id,
      id: input.nodeRun.workflowRunId,
      status: input.status,
      error: failure,
    })
    return { node, run }
  })
}

async function emitNodeSucceeded(
  sixb: AgentWorkerSixb,
  node: WorkflowNodeRunRecord,
  totalNodes: number
): Promise<void> {
  await sixb.events.emit(
    {
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
    },
    { source: "SixbAgentWorker" }
  )
}

async function emitNodeAndRunFailed(
  sixb: AgentWorkerSixb,
  failed: { readonly node: WorkflowNodeRunRecord; readonly run: WorkflowRunRecord },
  totalNodes: number,
  status: "failed" | "cancelled"
): Promise<void> {
  await sixb.events.emit(
    {
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
    },
    { source: "SixbAgentWorker" }
  )
}

export async function enqueueWorkflowAgentNodeResume(
  sixb: AgentWorkerSixb,
  node: Pick<WorkflowNodeRunRecord, "id" | "workflowId" | "workflowRunId">
): Promise<void> {
  await sixb.queues.workflows.enqueue({
    projectId: sixb.id,
    jobs: [
      {
        id: workflowAgentResumeQueueJobId(node.id),
        type: "workflow.run.resume.requested",
        payload: {
          workflowId: node.workflowId,
          runId: node.workflowRunId,
          resume: { kind: "agentNode", nodeRunId: node.id },
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
  return isSixbError(error, "queue.lease_lost") || isSixbError(signal.reason, "queue.lease_lost")
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
    throw agentWorkerError(`Workflow run record '${record.id}' has no finishedAt.`)
  }
  return record.finishedAt
}
