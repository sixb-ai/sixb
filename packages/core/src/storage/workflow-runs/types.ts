import type { WorkflowIOSnapshot } from "../../workflows/types"

export type { WorkflowIOSnapshot } from "../../workflows/types"

export type WorkflowRunStatus = "running" | "succeeded" | "failed" | "cancelled"
export type WorkflowNodeRunStatus = WorkflowRunStatus
export type WorkflowNodeRunType = "step" | "action"

export interface WorkflowRunRecord {
  readonly id: string
  readonly projectId: string
  readonly workflowId: string
  readonly status: WorkflowRunStatus
  readonly input: WorkflowIOSnapshot
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly error?: string
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
  readonly error?: string
}

export interface StartWorkflowRunInput {
  readonly id: string
  readonly projectId: string
  readonly workflowId: string
  readonly input: WorkflowIOSnapshot
  readonly startedAt?: Date
}

export type FinishWorkflowRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly error?: string
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
}

export type FinishWorkflowNodeRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly output?: WorkflowIOSnapshot
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly error?: string
    }

export interface ListWorkflowRunsInput {
  readonly projectId: string
  readonly workflowId?: string
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

  start(input: StartWorkflowRunInput): Promise<WorkflowRunRecord>
  finish(input: FinishWorkflowRunInput): Promise<WorkflowRunRecord>
  getById(params: { projectId: string; id: string }): Promise<WorkflowRunRecord | null>
  list(input: ListWorkflowRunsInput): Promise<ListWorkflowRunsResult>
}

export interface WorkflowNodeRunStorage {
  start(input: StartWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord>
  finish(input: FinishWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord>
  getById(params: { projectId: string; id: string }): Promise<WorkflowNodeRunRecord | null>
  list(input: ListWorkflowNodeRunsInput): Promise<ListWorkflowNodeRunsResult>
}
