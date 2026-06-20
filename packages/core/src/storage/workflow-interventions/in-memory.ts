import { cloneRecord, hasEmptyStatuses, paginate, storageKey, toStatusSet } from "../run-listing"
import { WorkflowInterventionError } from "./errors"
import type {
  CancelWorkflowInterventionInput,
  CreateWorkflowInterventionInput,
  ExpireWorkflowInterventionInput,
  ListWorkflowInterventionsInput,
  ListWorkflowInterventionsResult,
  SubmitWorkflowInterventionInput,
  WorkflowInterventionRecord,
  WorkflowInterventionStorage,
} from "./types"

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowInterventionError(
      `[Sixb] Workflow intervention ${fieldName} must be a non-negative integer.`
    )
  }
}

export class InMemoryWorkflowInterventionStorage implements WorkflowInterventionStorage {
  private readonly interventions = new Map<string, WorkflowInterventionRecord>()

  snapshot(): InMemoryWorkflowInterventionStorageSnapshot {
    return structuredClone(this.interventions)
  }

  restore(snapshot: InMemoryWorkflowInterventionStorageSnapshot): void {
    this.interventions.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.interventions.set(key, record)
    }
  }

  async create(input: CreateWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    assertNonNegativeInteger(input.nodeIndex, "nodeIndex")

    const key = storageKey(input.projectId, input.id)
    if (this.interventions.has(key)) {
      throw new WorkflowInterventionError(
        `[Sixb] Workflow intervention '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const record: WorkflowInterventionRecord = {
      id: input.id,
      projectId: input.projectId,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      nodeRunId: input.nodeRunId,
      nodeIndex: input.nodeIndex,
      nodeId: input.nodeId,
      nodeKey: input.nodeKey,
      interventionId: input.interventionId,
      input: cloneRecord(input.input),
      defaultResponse: cloneRecord(input.defaultResponse),
      status: "pending",
      requestedAt: new Date(input.requestedAt ?? new Date()),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    }

    this.interventions.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async submit(input: SubmitWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    const existing = this.requirePendingIntervention(input.projectId, input.id)
    const next: WorkflowInterventionRecord = {
      ...existing,
      status: "submitted",
      submittedAt: new Date(input.submittedAt ?? new Date()),
      submittedBy: input.submittedBy ? cloneRecord(input.submittedBy) : undefined,
      response: cloneRecord(input.response),
    }

    this.interventions.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async cancel(input: CancelWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    const existing = this.requirePendingIntervention(input.projectId, input.id)
    const next: WorkflowInterventionRecord = {
      ...existing,
      status: "cancelled",
      cancelledAt: new Date(input.cancelledAt ?? new Date()),
      cancelledBy: input.cancelledBy ? cloneRecord(input.cancelledBy) : undefined,
    }

    this.interventions.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async expire(input: ExpireWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    const existing = this.requirePendingIntervention(input.projectId, input.id)
    const next: WorkflowInterventionRecord = {
      ...existing,
      status: "expired",
      expiredAt: new Date(input.expiredAt ?? new Date()),
    }

    this.interventions.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async getById(params: {
    projectId: string
    id: string
  }): Promise<WorkflowInterventionRecord | null> {
    const record = this.interventions.get(storageKey(params.projectId, params.id))
    return record ? cloneRecord(record) : null
  }

  async list(input: ListWorkflowInterventionsInput): Promise<ListWorkflowInterventionsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        interventions: [],
        hasMore: false,
        total: 0,
      }
    }

    const order = input.order ?? "desc"
    const statuses = toStatusSet(input.statuses)
    const filtered = [...this.interventions.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => (statuses ? statuses.has(record.status) : true))
      .filter((record) => (input.workflowId ? record.workflowId === input.workflowId : true))
      .filter((record) =>
        input.workflowRunId ? record.workflowRunId === input.workflowRunId : true
      )
      .filter((record) => (input.nodeRunId ? record.nodeRunId === input.nodeRunId : true))
      .filter((record) => (input.nodeId ? record.nodeId === input.nodeId : true))
      .filter((record) => (input.nodeKey ? record.nodeKey === input.nodeKey : true))
      .filter((record) =>
        input.interventionId ? record.interventionId === input.interventionId : true
      )
      .filter((record) =>
        input.requestedAfter ? record.requestedAt >= input.requestedAfter : true
      )
      .filter((record) =>
        input.requestedBefore ? record.requestedAt <= input.requestedBefore : true
      )
      .sort((left, right) => compareRequestedAt(left, right, order))

    const { page, total, hasMore } = paginate(filtered, input)

    return {
      interventions: page.map(cloneRecord),
      hasMore,
      total,
    }
  }

  private requirePendingIntervention(projectId: string, id: string): WorkflowInterventionRecord {
    const record = this.interventions.get(storageKey(projectId, id))
    if (!record) {
      throw new WorkflowInterventionError(
        `[Sixb] Workflow intervention '${id}' not found for project '${projectId}'.`
      )
    }

    if (record.status !== "pending") {
      throw new WorkflowInterventionError(
        `[Sixb] Workflow intervention '${id}' for project '${projectId}' is not pending.`
      )
    }

    return record
  }
}

export type InMemoryWorkflowInterventionStorageSnapshot = Map<string, WorkflowInterventionRecord>

function compareRequestedAt(
  left: { readonly id: string; readonly requestedAt: Date },
  right: { readonly id: string; readonly requestedAt: Date },
  order: "asc" | "desc"
): number {
  const delta = left.requestedAt.getTime() - right.requestedAt.getTime()
  if (delta !== 0) {
    return order === "asc" ? delta : -delta
  }

  if (left.id === right.id) {
    return 0
  }

  return order === "asc" ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id)
}
