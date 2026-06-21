import {
  cloneRecord,
  compareStartedAt,
  hasEmptyStatuses,
  latestStartedAtByOwnerId,
  matchesRunListDateFilters,
  paginate,
  storageKey,
  toStatusSet,
} from "../run-listing"
import { WorkflowRunError } from "./errors"
import type {
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListLatestWorkflowRunsInput,
  ListLatestWorkflowRunsResult,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  QueueWorkflowRunInput,
  ResumeWorkflowRunInput,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
  WaitWorkflowNodeRunInput,
  WaitWorkflowRunInput,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStorage,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "./types"

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowRunError(`[Sixb] Workflow run ${fieldName} must be a non-negative integer.`)
  }
}

export class InMemoryWorkflowRunStorage implements WorkflowRunStorage {
  readonly nodes: InMemoryWorkflowNodeRunStorage

  private readonly runs = new Map<string, WorkflowRunRecord>()

  constructor() {
    this.nodes = new InMemoryWorkflowNodeRunStorage({
      requireRunningWorkflowRun: (projectId, id) => this.requireRunningWorkflowRun(projectId, id),
      requireActiveWorkflowRun: (projectId, id) => this.requireActiveWorkflowRun(projectId, id),
    })
  }

  snapshot(): InMemoryWorkflowRunStorageSnapshot {
    return {
      runs: structuredClone(this.runs),
      nodes: this.nodes.snapshot(),
    }
  }

  restore(snapshot: InMemoryWorkflowRunStorageSnapshot): void {
    this.runs.clear()
    for (const [key, record] of structuredClone(snapshot.runs)) {
      this.runs.set(key, record)
    }
    this.nodes.restore(snapshot.nodes)
  }

  async queue(input: QueueWorkflowRunInput): Promise<WorkflowRunRecord> {
    const key = storageKey(input.projectId, input.id)
    if (this.runs.has(key)) {
      throw new WorkflowRunError(
        `[Sixb] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const queuedAt = new Date(input.queuedAt ?? new Date())
    const record: WorkflowRunRecord = {
      id: input.id,
      projectId: input.projectId,
      workflowId: input.workflowId,
      status: "queued",
      input: cloneRecord(input.input),
      queuedAt,
      startedAt: queuedAt,
      ...(input.source ? { source: cloneRecord(input.source) } : {}),
    }

    this.runs.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async start(input: StartWorkflowRunInput): Promise<WorkflowRunRecord> {
    const key = storageKey(input.projectId, input.id)
    const existing = this.runs.get(key)
    if (existing) {
      if (existing.status !== "queued") {
        throw new WorkflowRunError(
          `[Sixb] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      if (existing.workflowId !== input.workflowId) {
        throw new WorkflowRunError(
          `[Sixb] Workflow run '${input.id}' workflow '${input.workflowId}' does not match existing workflow '${existing.workflowId}'.`
        )
      }

      const next: WorkflowRunRecord = {
        ...existing,
        status: "running",
        input: cloneRecord(input.input),
        startedAt: new Date(input.startedAt ?? new Date()),
        finishedAt: undefined,
        error: undefined,
      }

      this.runs.set(key, cloneRecord(next))
      return cloneRecord(next)
    }

    const record: WorkflowRunRecord = {
      id: input.id,
      projectId: input.projectId,
      workflowId: input.workflowId,
      status: "running",
      input: cloneRecord(input.input),
      startedAt: new Date(input.startedAt ?? new Date()),
    }

    this.runs.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async finish(input: FinishWorkflowRunInput): Promise<WorkflowRunRecord> {
    const existing = this.requireFinishableWorkflowRun(input)
    const base: WorkflowRunRecord = {
      ...existing,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
    }

    const next: WorkflowRunRecord =
      input.status === "succeeded"
        ? {
            ...base,
            error: undefined,
          }
        : {
            ...base,
            error: input.error,
          }

    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async wait(input: WaitWorkflowRunInput): Promise<WorkflowRunRecord> {
    const existing = this.requireRunningWorkflowRun(input.projectId, input.id)
    const next: WorkflowRunRecord = {
      ...existing,
      status: "waiting",
      finishedAt: undefined,
      error: undefined,
    }

    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async resume(input: ResumeWorkflowRunInput): Promise<WorkflowRunRecord> {
    const existing = this.requireWaitingWorkflowRun(input.projectId, input.id)
    const next: WorkflowRunRecord = {
      ...existing,
      status: "running",
      finishedAt: undefined,
      error: undefined,
    }

    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<WorkflowRunRecord | null> {
    const record = this.runs.get(storageKey(params.projectId, params.id))
    return record ? cloneRecord(record) : null
  }

  async list(input: ListWorkflowRunsInput): Promise<ListWorkflowRunsResult> {
    if (hasEmptyStatuses(input) || input.workflowIds?.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const order = input.order ?? "desc"
    const statuses = toStatusSet(input.statuses)
    const workflowIds = input.workflowIds ? new Set(input.workflowIds) : null
    const filtered = [...this.runs.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => (input.workflowId ? record.workflowId === input.workflowId : true))
      .filter((record) => (workflowIds ? workflowIds.has(record.workflowId) : true))
      .filter((record) =>
        matchesRunListDateFilters(record, {
          statuses,
          startedAfter: input.startedAfter,
          startedBefore: input.startedBefore,
        })
      )
      .sort((left, right) => compareStartedAt(left, right, order))

    const { page, total, hasMore } = paginate(filtered, input)

    return {
      runs: page.map(cloneRecord),
      hasMore,
      total,
    }
  }

  async listLatestByWorkflowIds(
    input: ListLatestWorkflowRunsInput
  ): Promise<ListLatestWorkflowRunsResult> {
    const runs = latestStartedAtByOwnerId(
      [...this.runs.values()].filter((record) => record.projectId === input.projectId),
      input.workflowIds,
      (record) => record.workflowId
    )

    return {
      runs: runs.map(cloneRecord),
    }
  }

  private requireExistingWorkflowRun(projectId: string, id: string): WorkflowRunRecord {
    const record = this.runs.get(storageKey(projectId, id))
    if (!record) {
      throw new WorkflowRunError(
        `[Sixb] Workflow run '${id}' not found for project '${projectId}'.`
      )
    }

    return record
  }

  private requireRunningWorkflowRun(projectId: string, id: string): WorkflowRunRecord {
    const record = this.requireExistingWorkflowRun(projectId, id)
    if (record.status !== "running") {
      throw new WorkflowRunError(
        `[Sixb] Workflow run '${id}' for project '${projectId}' must be running.`
      )
    }

    return record
  }

  private requireWaitingWorkflowRun(projectId: string, id: string): WorkflowRunRecord {
    const record = this.requireExistingWorkflowRun(projectId, id)
    if (record.status !== "waiting") {
      throw new WorkflowRunError(
        `[Sixb] Workflow run '${id}' for project '${projectId}' must be waiting.`
      )
    }

    return record
  }

  private requireActiveWorkflowRun(projectId: string, id: string): WorkflowRunRecord {
    const record = this.requireExistingWorkflowRun(projectId, id)
    if (record.status !== "running" && record.status !== "waiting") {
      throw new WorkflowRunError(
        `[Sixb] Workflow run '${id}' for project '${projectId}' is already terminal.`
      )
    }

    return record
  }

  private requireFinishableWorkflowRun(input: FinishWorkflowRunInput): WorkflowRunRecord {
    const record = this.requireExistingWorkflowRun(input.projectId, input.id)
    if (record.status === "running") {
      return record
    }

    if (record.status === "waiting" && input.status === "cancelled") {
      return record
    }

    if (record.status === "queued" && input.status !== "succeeded") {
      return record
    }

    throw new WorkflowRunError(
      `[Sixb] Workflow run '${input.id}' for project '${input.projectId}' cannot be finished from status '${record.status}'.`
    )
  }
}

export class InMemoryWorkflowNodeRunStorage implements WorkflowNodeRunStorage {
  private readonly nodes = new Map<string, WorkflowNodeRunRecord>()

  constructor(
    private readonly workflowRuns: {
      requireRunningWorkflowRun(projectId: string, id: string): WorkflowRunRecord
      requireActiveWorkflowRun(projectId: string, id: string): WorkflowRunRecord
    }
  ) {}

  snapshot(): InMemoryWorkflowNodeRunStorageSnapshot {
    return structuredClone(this.nodes)
  }

  restore(snapshot: InMemoryWorkflowNodeRunStorageSnapshot): void {
    this.nodes.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.nodes.set(key, record)
    }
  }

  async start(input: StartWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    assertNonNegativeInteger(input.nodeIndex, "nodeIndex")

    const workflowRun = this.workflowRuns.requireRunningWorkflowRun(
      input.projectId,
      input.workflowRunId
    )
    if (workflowRun.workflowId !== input.workflowId) {
      throw new WorkflowRunError(
        `[Sixb] Workflow node run '${input.id}' workflow '${input.workflowId}' does not match workflow run '${input.workflowRunId}' workflow '${workflowRun.workflowId}'.`
      )
    }

    const key = storageKey(input.projectId, input.id)
    if (this.nodes.has(key)) {
      throw new WorkflowRunError(
        `[Sixb] Workflow node run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const record: WorkflowNodeRunRecord = {
      id: input.id,
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      workflowId: input.workflowId,
      nodeIndex: input.nodeIndex,
      nodeType: input.nodeType,
      nodeId: input.nodeId,
      nodeKey: input.nodeKey,
      status: "running",
      input: cloneRecord(input.input),
      startedAt: new Date(input.startedAt ?? new Date()),
    }

    this.nodes.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async finish(input: FinishWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    const existing = this.requireActiveNodeRun(input.projectId, input.id)
    const base: WorkflowNodeRunRecord = {
      ...existing,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
    }

    const next: WorkflowNodeRunRecord =
      input.status === "succeeded"
        ? {
            ...base,
            output: input.output ? cloneRecord(input.output) : undefined,
            error: undefined,
          }
        : {
            ...base,
            output: undefined,
            error: input.error,
          }

    this.nodes.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async wait(input: WaitWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    const existing = this.requireRunningNodeRun(input.projectId, input.id)
    this.workflowRuns.requireActiveWorkflowRun(input.projectId, existing.workflowRunId)

    const next: WorkflowNodeRunRecord = {
      ...existing,
      status: "waiting",
      finishedAt: undefined,
      output: undefined,
      error: undefined,
    }

    this.nodes.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<WorkflowNodeRunRecord | null> {
    const record = this.nodes.get(storageKey(params.projectId, params.id))
    return record ? cloneRecord(record) : null
  }

  async list(input: ListWorkflowNodeRunsInput): Promise<ListWorkflowNodeRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        nodes: [],
        hasMore: false,
        total: 0,
      }
    }

    const order = input.order ?? "desc"
    const statuses = toStatusSet(input.statuses)
    const filtered = [...this.nodes.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) =>
        input.workflowRunId ? record.workflowRunId === input.workflowRunId : true
      )
      .filter((record) => (input.workflowId ? record.workflowId === input.workflowId : true))
      .filter((record) => (input.nodeType ? record.nodeType === input.nodeType : true))
      .filter((record) => (input.nodeId ? record.nodeId === input.nodeId : true))
      .filter((record) => (input.nodeKey ? record.nodeKey === input.nodeKey : true))
      .filter((record) =>
        matchesRunListDateFilters(record, {
          statuses,
          startedAfter: input.startedAfter,
          startedBefore: input.startedBefore,
        })
      )
      .sort((left, right) => compareStartedAt(left, right, order))

    const { page, total, hasMore } = paginate(filtered, input)

    return {
      nodes: page.map(cloneRecord),
      hasMore,
      total,
    }
  }

  private requireRunningNodeRun(projectId: string, id: string): WorkflowNodeRunRecord {
    const record = this.nodes.get(storageKey(projectId, id))
    if (!record) {
      throw new WorkflowRunError(
        `[Sixb] Workflow node run '${id}' not found for project '${projectId}'.`
      )
    }

    if (record.status !== "running") {
      throw new WorkflowRunError(
        `[Sixb] Workflow node run '${id}' for project '${projectId}' must be running.`
      )
    }

    return record
  }

  private requireActiveNodeRun(projectId: string, id: string): WorkflowNodeRunRecord {
    const record = this.nodes.get(storageKey(projectId, id))
    if (!record) {
      throw new WorkflowRunError(
        `[Sixb] Workflow node run '${id}' not found for project '${projectId}'.`
      )
    }

    if (record.status !== "running" && record.status !== "waiting") {
      throw new WorkflowRunError(
        `[Sixb] Workflow node run '${id}' for project '${projectId}' is already terminal.`
      )
    }

    return record
  }
}

export interface InMemoryWorkflowRunStorageSnapshot {
  readonly runs: Map<string, WorkflowRunRecord>
  readonly nodes: InMemoryWorkflowNodeRunStorageSnapshot
}

export type InMemoryWorkflowNodeRunStorageSnapshot = Map<string, WorkflowNodeRunRecord>
