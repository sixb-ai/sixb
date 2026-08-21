import type { AgentMessagePart } from "../../agents/message"
import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { JsonValue } from "../../json"
import type { WorkflowIOSnapshot } from "../../workflows/types"
import type {
  AgentExecutionStatus,
  AgentRunFailureCode,
  AgentRunFinishReason,
  AgentRunUsage,
} from "../agents"

export type { WorkflowIOSnapshot } from "../../workflows/types"

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
export type WorkflowNodeRunStatus = Exclude<WorkflowRunStatus, "queued">
export type WorkflowNodeRunType = "step" | "action" | "intervention" | "agent"

/** Error codes a workflow or workflow-node run can persist and expose. */
export const WORKFLOW_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "runtime.cancelled",
  "workflow.node_failed",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type WorkflowRunFailureCode = (typeof WORKFLOW_RUN_FAILURE_CODES)[number]

export interface WorkflowRunExecution {
  readonly token: string
  readonly queueLeaseExpiresAt: Date
}

export type WorkflowAgentNodeRunStatus = AgentExecutionStatus

export interface WorkflowAgentNodeRunExecution {
  readonly token: string
  readonly queueLeaseExpiresAt: Date
}

/** Execution details for an agent workflow node. The generic node run owns business IO. */
export interface WorkflowAgentNodeRunRecord {
  readonly projectId: string
  readonly nodeRunId: string
  readonly executionId: string
  readonly agentId: string
  readonly status: WorkflowAgentNodeRunStatus
  readonly prompt: string
  readonly modelId?: string
  readonly finishReason?: AgentRunFinishReason
  readonly usage?: AgentRunUsage
  readonly trace?: readonly AgentMessagePart[]
  readonly diagnostics?: readonly JsonValue[]
  readonly error?: SixbFailure<AgentRunFailureCode>
  readonly attempt: number
  readonly execution?: WorkflowAgentNodeRunExecution
  readonly createdAt: Date
  readonly startedAt?: Date
  readonly completedAt?: Date
}

export interface CreateWorkflowAgentNodeRunInput {
  readonly projectId: string
  readonly nodeRunId: string
  readonly executionId: string
  readonly agentId: string
  readonly prompt: string
  readonly createdAt?: Date
}

export interface StartWorkflowAgentNodeRunInput {
  readonly projectId: string
  readonly nodeRunId: string
  readonly modelId?: string
  readonly execution: WorkflowAgentNodeRunExecution
  readonly startedAt?: Date
}

export interface ReclaimWorkflowAgentNodeRunInput {
  readonly projectId: string
  readonly nodeRunId: string
  readonly execution: WorkflowAgentNodeRunExecution
}

export interface ConfirmWorkflowAgentNodeRunExecutionOwnershipInput {
  readonly projectId: string
  readonly nodeRunId: string
  readonly executionToken: string
  readonly queueLeaseExpiresAt: Date
}

interface FinishWorkflowAgentNodeRunBaseInput {
  readonly projectId: string
  readonly nodeRunId: string
  readonly executionToken: string
  readonly modelId?: string
  readonly finishReason?: AgentRunFinishReason
  readonly usage?: AgentRunUsage
  readonly trace?: readonly AgentMessagePart[]
  readonly diagnostics?: readonly JsonValue[]
  readonly completedAt?: Date
}

export type FinishWorkflowAgentNodeRunInput =
  | (FinishWorkflowAgentNodeRunBaseInput & {
      readonly status: "succeeded"
    })
  | (FinishWorkflowAgentNodeRunBaseInput & {
      readonly status: "failed" | "cancelled"
      readonly error?: SixbFailure<AgentRunFailureCode>
    })

export interface CancelWorkflowAgentNodeRunInput {
  readonly projectId: string
  readonly nodeRunId: string
  readonly error?: SixbFailure<AgentRunFailureCode>
  readonly completedAt?: Date
}

export interface ListWorkflowAgentNodeRunsInput {
  readonly projectId: string
  readonly agentId?: string
  readonly statuses?: readonly WorkflowAgentNodeRunStatus[]
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListWorkflowAgentNodeRunsResult {
  readonly runs: readonly WorkflowAgentNodeRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface WorkflowRunRecord {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly workflowId: string
  readonly status: WorkflowRunStatus
  readonly input: WorkflowIOSnapshot
  readonly output?: WorkflowIOSnapshot
  readonly queuedAt?: Date
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly error?: SixbFailure<WorkflowRunFailureCode>
  /** Durable group memberships snapshotted when the workflow run was admitted. */
  readonly requesterGroupIds: readonly string[]
  readonly attempt: number
  readonly execution?: WorkflowRunExecution
}

export interface WorkflowNodeRunRecord {
  readonly id: string
  readonly projectId: string
  readonly workflowRunId: string
  readonly workflowId: string
  readonly nodeIndex: number
  readonly nodeType: WorkflowNodeRunType
  readonly nodeId: string
  readonly nodeKey: string
  readonly status: WorkflowNodeRunStatus
  readonly input: WorkflowIOSnapshot
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly output?: WorkflowIOSnapshot
  readonly error?: SixbFailure<WorkflowRunFailureCode>
}

export interface StartWorkflowRunInput {
  readonly id: string
  readonly projectId: string
  readonly startedAt?: Date
  readonly execution?: WorkflowRunExecution
}

export interface QueueWorkflowRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly workflowId: string
  readonly input: WorkflowIOSnapshot
  readonly queuedAt?: Date
  readonly requesterGroupIds: readonly string[]
}

export interface ReclaimWorkflowRunInput {
  readonly id: string
  readonly projectId: string
  readonly execution: WorkflowRunExecution
}

export interface ConfirmWorkflowRunExecutionOwnershipInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
  readonly queueLeaseExpiresAt: Date
}

export interface WaitWorkflowRunInput {
  readonly id: string
  readonly projectId: string
  readonly waitingAt?: Date
  readonly executionToken?: string
}

export interface ResumeWorkflowRunInput {
  readonly id: string
  readonly projectId: string
  readonly resumedAt?: Date
  readonly execution?: WorkflowRunExecution
}

export type FinishWorkflowRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly output: WorkflowIOSnapshot
      readonly finishedAt?: Date
      readonly executionToken?: string
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly error?: SixbFailure<WorkflowRunFailureCode>
      readonly executionToken?: string
    }

export interface StartWorkflowNodeRunInput {
  readonly id: string
  readonly projectId: string
  readonly workflowRunId: string
  readonly workflowId: string
  readonly nodeIndex: number
  readonly nodeType: WorkflowNodeRunType
  readonly nodeId: string
  readonly nodeKey: string
  readonly input: WorkflowIOSnapshot
  readonly startedAt?: Date
  readonly executionToken?: string
}

export interface WaitWorkflowNodeRunInput {
  readonly id: string
  readonly projectId: string
  readonly waitingAt?: Date
  readonly executionToken?: string
}

export type FinishWorkflowNodeRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly output?: WorkflowIOSnapshot
      readonly executionToken?: string
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly error?: SixbFailure<WorkflowRunFailureCode>
      readonly executionToken?: string
    }

export interface ListWorkflowRunsInput {
  readonly projectId: string
  readonly workflowId?: string
  readonly workflowIds?: readonly string[]
  readonly statuses?: readonly WorkflowRunStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListWorkflowRunsResult {
  readonly runs: readonly WorkflowRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface ListLatestWorkflowRunsInput {
  readonly projectId: string
  readonly workflowIds: readonly string[]
}

export interface ListLatestWorkflowRunsResult {
  readonly runs: readonly WorkflowRunRecord[]
}

export interface ListWorkflowNodeRunsInput {
  readonly projectId: string
  readonly workflowRunId?: string
  readonly workflowId?: string
  readonly nodeType?: WorkflowNodeRunType
  readonly nodeId?: string
  readonly nodeKey?: string
  readonly statuses?: readonly WorkflowNodeRunStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListWorkflowNodeRunsResult {
  readonly nodes: readonly WorkflowNodeRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface WorkflowRunStorage {
  readonly nodes: WorkflowNodeRunStorage
  readonly agentNodes: WorkflowAgentNodeRunStorage

  queue(input: QueueWorkflowRunInput): Promise<WorkflowRunRecord>
  /** Atomically claims a queued run by transitioning it to running; competing claims must fail. */
  start(input: StartWorkflowRunInput): Promise<WorkflowRunRecord>
  reclaim(input: ReclaimWorkflowRunInput): Promise<WorkflowRunRecord>
  confirmExecutionOwnership(
    input: ConfirmWorkflowRunExecutionOwnershipInput
  ): Promise<WorkflowRunRecord>
  wait(input: WaitWorkflowRunInput): Promise<WorkflowRunRecord>
  resume(input: ResumeWorkflowRunInput): Promise<WorkflowRunRecord>
  finish(input: FinishWorkflowRunInput): Promise<WorkflowRunRecord>
  getById(params: { projectId: string; id: string }): Promise<WorkflowRunRecord | null>
  list(input: ListWorkflowRunsInput): Promise<ListWorkflowRunsResult>
  listLatestByWorkflowIds(input: ListLatestWorkflowRunsInput): Promise<ListLatestWorkflowRunsResult>
}

export interface WorkflowAgentNodeRunStorage {
  create(input: CreateWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord>
  start(input: StartWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord>
  reclaim(input: ReclaimWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord>
  confirmExecutionOwnership(
    input: ConfirmWorkflowAgentNodeRunExecutionOwnershipInput
  ): Promise<WorkflowAgentNodeRunRecord>
  cancel(input: CancelWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord>
  finish(input: FinishWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord>
  getByNodeRunId(params: {
    projectId: string
    nodeRunId: string
  }): Promise<WorkflowAgentNodeRunRecord | null>
  list(input: ListWorkflowAgentNodeRunsInput): Promise<ListWorkflowAgentNodeRunsResult>
}

export interface WorkflowNodeRunStorage {
  start(input: StartWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord>
  wait(input: WaitWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord>
  finish(input: FinishWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord>
  getById(params: { projectId: string; id: string }): Promise<WorkflowNodeRunRecord | null>
  list(input: ListWorkflowNodeRunsInput): Promise<ListWorkflowNodeRunsResult>
}
