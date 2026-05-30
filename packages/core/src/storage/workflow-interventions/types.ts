import type { WorkflowIOSnapshot } from "../workflow-runs"

export type WorkflowInterventionStatus = "pending" | "submitted" | "cancelled" | "expired"

export interface WorkflowInterventionActor {
  readonly principalType: "user" | "serviceAccount" | "system"
  readonly principalId: string
}

export interface WorkflowInterventionRecord {
  readonly id: string
  readonly projectId: string
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeRunId: string
  readonly nodeIndex: number
  readonly nodeId: string
  readonly nodeKey: string
  readonly interventionId: string
  readonly input: WorkflowIOSnapshot
  readonly defaultResponse: WorkflowIOSnapshot
  readonly status: WorkflowInterventionStatus
  readonly requestedAt: Date
  readonly expiresAt?: Date
  readonly submittedAt?: Date
  readonly submittedBy?: WorkflowInterventionActor
  readonly response?: WorkflowIOSnapshot
  readonly cancelledAt?: Date
  readonly cancelledBy?: WorkflowInterventionActor
  readonly expiredAt?: Date
}

export interface CreateWorkflowInterventionInput {
  readonly id: string
  readonly projectId: string
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeRunId: string
  readonly nodeIndex: number
  readonly nodeId: string
  readonly nodeKey: string
  readonly interventionId: string
  readonly input: WorkflowIOSnapshot
  readonly defaultResponse: WorkflowIOSnapshot
  readonly requestedAt?: Date
  readonly expiresAt?: Date
}

export interface SubmitWorkflowInterventionInput {
  readonly projectId: string
  readonly id: string
  readonly response: WorkflowIOSnapshot
  readonly submittedAt?: Date
  readonly submittedBy?: WorkflowInterventionActor
}

export interface CancelWorkflowInterventionInput {
  readonly projectId: string
  readonly id: string
  readonly cancelledAt?: Date
  readonly cancelledBy?: WorkflowInterventionActor
}

export interface ExpireWorkflowInterventionInput {
  readonly projectId: string
  readonly id: string
  readonly expiredAt?: Date
}

export interface ListWorkflowInterventionsInput {
  readonly projectId: string
  readonly statuses?: readonly WorkflowInterventionStatus[]
  readonly workflowId?: string
  readonly workflowRunId?: string
  readonly nodeRunId?: string
  readonly nodeId?: string
  readonly nodeKey?: string
  readonly interventionId?: string
  readonly requestedAfter?: Date
  readonly requestedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListWorkflowInterventionsResult {
  readonly interventions: readonly WorkflowInterventionRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface WorkflowInterventionStorage {
  create(input: CreateWorkflowInterventionInput): Promise<WorkflowInterventionRecord>
  submit(input: SubmitWorkflowInterventionInput): Promise<WorkflowInterventionRecord>
  cancel(input: CancelWorkflowInterventionInput): Promise<WorkflowInterventionRecord>
  expire(input: ExpireWorkflowInterventionInput): Promise<WorkflowInterventionRecord>
  getById(params: { projectId: string; id: string }): Promise<WorkflowInterventionRecord | null>
  list(input: ListWorkflowInterventionsInput): Promise<ListWorkflowInterventionsResult>
}
