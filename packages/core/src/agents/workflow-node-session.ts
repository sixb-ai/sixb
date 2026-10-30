import type { Broker } from "../broker"
import type { SixbFailure } from "../errors/types"
import type { DomainEventLog } from "../events/service"
import type { AuthorizationRef } from "../execution"
import type { JsonValue } from "../json"
import {
  AiModelCallRecorder,
  createAiModelCallLimitController,
  type ModelCallAccountingStorage,
  type RecoverAiModelCall,
} from "../models/execution/index"
import type { Queue, WorkflowQueueJob, WorkflowQueueJobFailureCode } from "../queues"
import type { SecurityDefinitionCatalog } from "../security"
import type { Storage } from "../storage"
import type { AgentRunFailureCode, AgentRunFinishReason } from "../storage/agents"
import type { AuthStorage } from "../storage/auth"
import type { ExecutionRecord } from "../storage/executions/types"
import type {
  WorkflowAgentNodeRunRecord,
  WorkflowNodeRunRecord,
  WorkflowRunFailureCode,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "../storage/workflow-runs"
import { resolveAgentExecutionAuthorization } from "./authority"
import { createAgentRunExecutionToken } from "./ids"
import type { AgentMessagePart } from "./message"
import { AgentExecutionLostError } from "./run-fence"
import { type AgentRunPeople, agentRunPeople, watchAgentRunCancel } from "./run-session"

/**
 * A workflow agent step's session: the step's agent node, claimed with a fresh execution token,
 * and what the step does to shared state. Its finish ends the node and, when it failed, the
 * workflow run, in one transaction fenced by the token, then publishes the outcome and, once the
 * node succeeded, queues the workflow to resume.
 */
export interface WorkflowAgentNodeSession {
  /** The agent node as the claim left it: `running`, with this session's execution. */
  readonly node: WorkflowAgentNodeRunRecord
  readonly executionToken: string
  /** Aborts once the step's node is cancelled. */
  readonly cancelled: AbortSignal
  renewLease(leaseExpiresAt: string): Promise<void>
  /** Throws {@link AgentExecutionLostError} unless the node still runs under this session. */
  assertOwned(): Promise<void>
  /** Whether someone already cancelled the node, which then ended without this session. */
  wasCancelled(): Promise<boolean>
  /** The step's model calls, as a run session's: read on first use, again after a failed read. */
  modelCalls(): Promise<AiModelCallRecorder>
  /** The step's execution: whom its workflow runs for, and the authority it refers to. */
  execution(): Promise<ExecutionRecord | null>
  /** Members, as a run session reads them. */
  readonly people: AgentRunPeople
  /** The authority the step's actor carries now, under its workflow's execution. */
  authorizeActor(
    actorId: string,
    ref: AuthorizationRef
  ): ReturnType<typeof resolveAgentExecutionAuthorization>
  /** The node answered. Throws {@link WorkflowResumeDispatchError} when its resume is not queued. */
  finishSucceeded(input: {
    readonly modelId: string
    readonly finishReason: AgentRunFinishReason
    readonly trace: readonly AgentMessagePart[]
    readonly output: Readonly<Record<string, JsonValue>>
    /** The workflow's node count, which the node's event names. */
    readonly totalNodes: number
  }): Promise<WorkflowNodeRunRecord>
  /** The node failed or was cancelled, and its workflow run with it. */
  finishFailed(input: {
    readonly status: "failed" | "cancelled"
    readonly at: Date
    readonly modelId?: string
    readonly finishReason?: AgentRunFinishReason
    readonly trace?: readonly AgentMessagePart[]
    readonly agentError: SixbFailure<AgentRunFailureCode>
    readonly workflowError: SixbFailure<WorkflowRunFailureCode>
    /** Absent when the workflow's definition is gone: its node event is then left out. */
    readonly totalNodes?: number
  }): Promise<{ readonly node: WorkflowNodeRunRecord; readonly run: WorkflowRunRecord }>
  close(): void
}

export interface WorkflowAgentNodeSessionHost {
  readonly projectId: string
  readonly storage: Storage & { readonly auth: AuthStorage } & ModelCallAccountingStorage
  readonly broker: Broker
  readonly recoverAiModelCall: RecoverAiModelCall
  readonly events: DomainEventLog
  readonly workflowQueue: Queue<WorkflowQueueJob, WorkflowQueueJobFailureCode>
  readonly security: SecurityDefinitionCatalog
}

/**
 * A workflow agent node succeeded but its workflow resume could not be queued. The runner leaves
 * the node's job unacknowledged: a redelivery finds the node succeeded and only re-sends the resume.
 */
export class WorkflowResumeDispatchError extends Error {
  readonly name = "WorkflowResumeDispatchError"
  constructor(
    readonly nodeRunId: string,
    options?: ErrorOptions
  ) {
    super(`[Sixb] Could not queue the workflow resume after agent node '${nodeRunId}'.`, options)
  }
}

/** Short in-place retries that absorb a transient storage blip, as a run's finish has. */
const FINISH_BACKOFF_MS = [50, 200, 600] as const

async function retryFinish<T>(
  finish: () => Promise<T>,
  committed: () => Promise<T | null>
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await finish()
    } catch (error) {
      const delay = FINISH_BACKOFF_MS[attempt]
      if (delay === undefined) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
      const done = await committed().catch((reason: unknown) => {
        if (reason instanceof AgentExecutionLostError) throw reason
        return null
      })
      if (done) return done
    }
  }
}

/** Start a queued agent node, or reclaim a running one, and open its session. */
export async function claimWorkflowAgentNode(
  host: WorkflowAgentNodeSessionHost,
  input: {
    readonly node: WorkflowAgentNodeRunRecord
    readonly nodeRun: WorkflowNodeRunRecord
    readonly leaseExpiresAt: string
  }
): Promise<WorkflowAgentNodeSession> {
  const { projectId } = host
  if (!host.storage.workflowRuns) {
    throw new Error("[Sixb] Workflow agent nodes require workflow storage.")
  }
  const agentNodes = host.storage.workflowRuns.agentNodes
  const execution = {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: new Date(input.leaseExpiresAt),
  }
  const claim = { projectId, nodeRunId: input.nodeRun.id, execution }
  const node =
    input.node.status === "queued" ? await agentNodes.start(claim) : await agentNodes.reclaim(claim)
  const executionToken = node.execution?.token
  if (!executionToken) {
    throw new Error(`[Sixb] Agent workflow node '${input.nodeRun.id}' has no execution token.`)
  }

  const nodeRun = input.nodeRun
  const fence = { projectId, nodeRunId: nodeRun.id, executionToken }
  const cancel = await watchAgentRunCancel(host, [nodeRun.id])
  let modelCalls: Promise<AiModelCallRecorder> | undefined

  const transaction = <T>(write: (runs: WorkflowRunStorage) => Promise<T>) =>
    host.storage.transaction(async (tx) => {
      if (!tx.workflowRuns) {
        throw new Error("[Sixb] Workflow storage disappeared during finalization.")
      }
      return write(tx.workflowRuns)
    })

  return {
    node,
    executionToken,
    cancelled: cancel.signal,
    async renewLease(leaseExpiresAt) {
      await agentNodes.confirmExecutionOwnership({
        ...fence,
        queueLeaseExpiresAt: new Date(leaseExpiresAt),
      })
    },
    async assertOwned() {
      const current = await agentNodes.getByNodeRunId({ projectId, nodeRunId: nodeRun.id })
      if (
        current?.status !== "running" ||
        current.execution?.token !== executionToken ||
        current.execution.queueLeaseExpiresAt.getTime() <= Date.now()
      ) {
        throw new AgentExecutionLostError(nodeRun.id)
      }
    },
    async wasCancelled() {
      const current = await agentNodes.getByNodeRunId({ projectId, nodeRunId: nodeRun.id })
      return current?.status === "cancelled"
    },
    modelCalls() {
      modelCalls ??= openNodeModelCalls(host, node).catch((error: unknown) => {
        modelCalls = undefined
        throw error
      })
      return modelCalls
    },
    execution: () => host.storage.executions.getById({ projectId, id: node.executionId }),
    people: agentRunPeople(host),
    authorizeActor: (actorId, ref) =>
      resolveAgentExecutionAuthorization({
        auth: host.storage.auth,
        projectId,
        actorId,
        authorizationRef: ref,
        security: host.security,
      }),
    async finishSucceeded(result) {
      // The agent already answered: a storage blip here must not fail its workflow.
      const finished = await retryFinish(
        () =>
          transaction(async (runs) => {
            await runs.agentNodes.finish({
              ...fence,
              status: "succeeded",
              modelId: result.modelId,
              finishReason: result.finishReason,
              trace: result.trace,
            })
            return runs.nodes.finish({
              projectId,
              id: nodeRun.id,
              status: "succeeded",
              output: result.output,
            })
          }),
        // A commit whose answer was lost: the node is already succeeded. Another runner that
        // reclaimed the node bumped its attempt, and what it finished is not this session's.
        async () => {
          const agentNode = await agentNodes.getByNodeRunId({ projectId, nodeRunId: nodeRun.id })
          if (agentNode && agentNode.attempt !== node.attempt) {
            throw new AgentExecutionLostError(nodeRun.id)
          }

          const current = await host.storage.workflowRuns?.nodes.getById({
            projectId,
            id: nodeRun.id,
          })
          return current?.status === "succeeded" ? current : null
        }
      )
      await host.events.emit(
        { events: [nodeFinishedEvent(finished, result.totalNodes, "succeeded")] },
        { source: "SixbAgentWorker" }
      )
      await enqueueWorkflowAgentNodeResume(host, nodeRun)
      return finished
    },
    async finishFailed(input) {
      const failed = await transaction(async (runs) => {
        await runs.agentNodes.finish({
          ...fence,
          status: input.status,
          modelId: input.modelId,
          finishReason: input.finishReason,
          trace: input.trace,
          error: input.agentError,
          completedAt: input.at,
        })
        const finishedNode = await runs.nodes.finish({
          projectId,
          id: nodeRun.id,
          status: input.status,
          finishedAt: input.at,
          error: input.workflowError,
        })
        const run = await runs.finish({
          projectId,
          id: nodeRun.workflowRunId,
          status: input.status,
          finishedAt: input.at,
          error: input.workflowError,
        })
        return { node: finishedNode, run }
      })
      await host.events.emit(
        {
          events: [
            // A removed definition has no trustworthy node count; the durable failure and run
            // event still describe the outcome without inventing workflow metadata.
            ...(input.totalNodes === undefined
              ? []
              : [nodeFinishedEvent(failed.node, input.totalNodes, input.status)]),
            {
              type: "workflow.run.finished",
              payload: {
                workflowId: failed.run.workflowId,
                runId: failed.run.id,
                status: input.status,
                finishedAt: requireFinishedAt(failed.run).toISOString(),
                ...(failed.run.error ? { error: failed.run.error } : {}),
              },
            },
          ],
        },
        { source: "SixbAgentWorker" }
      )
      return failed
    },
    close: cancel.stop,
  }
}

/**
 * Queue the workflow to resume after its agent node succeeded: once by the node's finish, again
 * by a redelivery that finds the node already succeeded. The job id makes the second a no-op.
 */
export async function enqueueWorkflowAgentNodeResume(
  host: Pick<WorkflowAgentNodeSessionHost, "projectId" | "workflowQueue">,
  node: Pick<WorkflowNodeRunRecord, "id" | "workflowRunId">
): Promise<void> {
  try {
    await host.workflowQueue.enqueue({
      projectId: host.projectId,
      jobs: [
        {
          id: `wfa_resume_${node.id}`,
          type: "workflow.run.resume.requested",
          payload: { runId: node.workflowRunId, nodeRunId: node.id },
        },
      ],
    })
  } catch (error) {
    throw new WorkflowResumeDispatchError(node.id, { cause: error })
  }
}

async function openNodeModelCalls(
  host: WorkflowAgentNodeSessionHost,
  node: WorkflowAgentNodeRunRecord
): Promise<AiModelCallRecorder> {
  const execution = await host.storage.executions.getById({
    projectId: host.projectId,
    id: node.executionId,
  })
  if (!execution) {
    throw new Error(
      `[Sixb] Agent workflow node '${node.nodeRunId}' references missing execution '${node.executionId}'.`
    )
  }
  return new AiModelCallRecorder({
    storage: host.storage,
    projectId: host.projectId,
    executionId: node.executionId,
    attempt: node.attempt,
    requesterGroupIds: execution.requesterGroupIds,
    limits: createAiModelCallLimitController({
      storage: host.storage,
      projectId: host.projectId,
      requestedBy: execution.requestedBy,
      requesterGroupIds: execution.requesterGroupIds,
    }),
    recoverAiModelCall: host.recoverAiModelCall,
  })
}

function nodeFinishedEvent(
  node: WorkflowNodeRunRecord,
  totalNodes: number,
  status: "succeeded" | "failed" | "cancelled"
) {
  return {
    type: "workflow.run.node.finished" as const,
    payload: {
      workflowId: node.workflowId,
      runId: node.workflowRunId,
      nodeRunId: node.id,
      nodeIndex: node.nodeIndex,
      totalNodes,
      nodeType: "agent" as const,
      nodeId: node.nodeId,
      nodeKey: node.nodeKey,
      status,
      finishedAt: requireFinishedAt(node).toISOString(),
      ...(status !== "succeeded" && node.error ? { error: node.error } : {}),
    },
  }
}

function requireFinishedAt(record: WorkflowNodeRunRecord | WorkflowRunRecord): Date {
  if (!record.finishedAt) {
    throw new Error(`[Sixb] Workflow record '${record.id}' finished without a finish time.`)
  }
  return record.finishedAt
}
