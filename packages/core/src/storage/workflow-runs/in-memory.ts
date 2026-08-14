import type { ExecutionStorage } from "../executions"
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
import { assertWorkflowAgentNodeRunExecution, assertWorkflowRunExecution } from "./provider"
import type {
  CancelWorkflowAgentNodeRunInput,
  ConfirmWorkflowAgentNodeRunExecutionOwnershipInput,
  ConfirmWorkflowRunExecutionOwnershipInput,
  CreateWorkflowAgentNodeRunInput,
  FinishWorkflowAgentNodeRunInput,
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListLatestWorkflowRunsInput,
  ListLatestWorkflowRunsResult,
  ListWorkflowAgentNodeRunsInput,
  ListWorkflowAgentNodeRunsResult,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  QueueWorkflowRunInput,
  ReclaimWorkflowAgentNodeRunInput,
  ReclaimWorkflowRunInput,
  ResumeWorkflowRunInput,
  StartWorkflowAgentNodeRunInput,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
  WaitWorkflowNodeRunInput,
  WaitWorkflowRunInput,
  WorkflowAgentNodeRunRecord,
  WorkflowAgentNodeRunStorage,
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
  readonly agentNodes: InMemoryWorkflowAgentNodeRunStorage

  private readonly runs = new Map<string, WorkflowRunRecord>()

  constructor(private readonly executions: ExecutionStorage) {
    this.nodes = new InMemoryWorkflowNodeRunStorage({
      requireRunningWorkflowRun: (projectId, id) => this.requireRunningWorkflowRun(projectId, id),
      requireActiveWorkflowRun: (projectId, id) => this.requireActiveWorkflowRun(projectId, id),
      assertExecutionOwnership: (projectId, id, token) =>
        this.assertExecutionOwnership(projectId, id, token),
    })
    this.agentNodes = new InMemoryWorkflowAgentNodeRunStorage(
      {
        requireAgentNodeRun: (projectId, id) => this.nodes.requireAgentNodeRun(projectId, id),
        requireWorkflowRun: (projectId, id) => this.requireExistingWorkflowRun(projectId, id),
      },
      this.executions
    )
  }

  snapshot(): InMemoryWorkflowRunStorageSnapshot {
    return {
      runs: structuredClone(this.runs),
      nodes: this.nodes.snapshot(),
      agentNodes: this.agentNodes.snapshot(),
    }
  }

  restore(snapshot: InMemoryWorkflowRunStorageSnapshot): void {
    this.runs.clear()
    for (const [key, record] of structuredClone(snapshot.runs)) {
      this.runs.set(key, record)
    }
    this.nodes.restore(snapshot.nodes)
    this.agentNodes.restore(snapshot.agentNodes)
  }

  async queue(input: QueueWorkflowRunInput): Promise<WorkflowRunRecord> {
    const key = storageKey(input.projectId, input.id)
    if (this.runs.has(key)) {
      throw new WorkflowRunError(
        `[Sixb] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }
    if (
      [...this.runs.values()].some(
        (run) => run.projectId === input.projectId && run.executionId === input.executionId
      )
    ) {
      throw new WorkflowRunError(
        `[Sixb] Execution '${input.executionId}' already belongs to another workflow run.`
      )
    }
    await assertWorkflowRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      workflowId: input.workflowId,
    })

    const queuedAt = new Date(input.queuedAt ?? new Date())
    const record: WorkflowRunRecord = {
      id: input.id,
      projectId: input.projectId,
      executionId: input.executionId,
      workflowId: input.workflowId,
      status: "queued",
      input: cloneRecord(input.input),
      queuedAt,
      startedAt: queuedAt,
      attempt: 0,
    }

    this.runs.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async start(input: StartWorkflowRunInput): Promise<WorkflowRunRecord> {
    const key = storageKey(input.projectId, input.id)
    const existing = this.runs.get(key)
    if (!existing || existing.status !== "queued") {
      throw new WorkflowRunError(
        existing
          ? `[Sixb] Workflow run '${input.id}' cannot start from status '${existing.status}'.`
          : `[Sixb] Workflow run '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const next: WorkflowRunRecord = {
      ...existing,
      status: "running",
      startedAt: new Date(input.startedAt ?? new Date()),
      finishedAt: undefined,
      error: undefined,
      attempt: existing.attempt + 1,
      execution: input.execution ? cloneRecord(input.execution) : undefined,
    }

    this.runs.set(key, cloneRecord(next))
    return cloneRecord(next)
  }

  async finish(input: FinishWorkflowRunInput): Promise<WorkflowRunRecord> {
    const existing = this.requireFinishableWorkflowRun(input)
    this.assertRecordExecutionOwnership(existing, input.executionToken)
    const base: WorkflowRunRecord = {
      ...existing,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
      execution: undefined,
    }

    const next: WorkflowRunRecord =
      input.status === "succeeded"
        ? {
            ...base,
            output: cloneRecord(input.output),
            error: undefined,
          }
        : {
            ...base,
            output: undefined,
            error: input.error,
          }

    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async wait(input: WaitWorkflowRunInput): Promise<WorkflowRunRecord> {
    const existing = this.requireRunningWorkflowRun(input.projectId, input.id)
    this.assertRecordExecutionOwnership(existing, input.executionToken)
    const next: WorkflowRunRecord = {
      ...existing,
      status: "waiting",
      finishedAt: undefined,
      error: undefined,
      execution: undefined,
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
      attempt: existing.attempt + 1,
      execution: input.execution ? cloneRecord(input.execution) : undefined,
    }

    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async reclaim(input: ReclaimWorkflowRunInput): Promise<WorkflowRunRecord> {
    const existing = this.requireRunningWorkflowRun(input.projectId, input.id)
    const next: WorkflowRunRecord = {
      ...existing,
      attempt: existing.attempt + 1,
      execution: cloneRecord(input.execution),
    }
    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async confirmExecutionOwnership(
    input: ConfirmWorkflowRunExecutionOwnershipInput
  ): Promise<WorkflowRunRecord> {
    const existing = this.requireRunningWorkflowRun(input.projectId, input.id)
    this.assertRecordExecutionOwnership(existing, input.executionToken)
    const next: WorkflowRunRecord = {
      ...existing,
      execution: {
        token: input.executionToken,
        queueLeaseExpiresAt: new Date(
          Math.max(
            existing.execution!.queueLeaseExpiresAt.getTime(),
            input.queueLeaseExpiresAt.getTime()
          )
        ),
      },
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

    if (record.status === "waiting" && input.status !== "succeeded") {
      return record
    }

    if (record.status === "queued" && input.status !== "succeeded") {
      return record
    }

    throw new WorkflowRunError(
      `[Sixb] Workflow run '${input.id}' for project '${input.projectId}' cannot be finished from status '${record.status}'.`
    )
  }

  private assertExecutionOwnership(projectId: string, id: string, token?: string): void {
    this.assertRecordExecutionOwnership(this.requireExistingWorkflowRun(projectId, id), token)
  }

  private assertRecordExecutionOwnership(record: WorkflowRunRecord, token?: string): void {
    if (record.execution?.token !== token) {
      throw new WorkflowRunError(
        `[Sixb] Execution token is no longer current on workflow run '${record.id}'.`
      )
    }
  }
}

export class InMemoryWorkflowNodeRunStorage implements WorkflowNodeRunStorage {
  private readonly nodes = new Map<string, WorkflowNodeRunRecord>()

  constructor(
    private readonly workflowRuns: {
      requireRunningWorkflowRun(projectId: string, id: string): WorkflowRunRecord
      requireActiveWorkflowRun(projectId: string, id: string): WorkflowRunRecord
      assertExecutionOwnership(projectId: string, id: string, token?: string): void
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
    this.workflowRuns.assertExecutionOwnership(
      input.projectId,
      input.workflowRunId,
      input.executionToken
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
    this.workflowRuns.assertExecutionOwnership(
      input.projectId,
      existing.workflowRunId,
      input.executionToken
    )
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
    this.workflowRuns.assertExecutionOwnership(
      input.projectId,
      existing.workflowRunId,
      input.executionToken
    )

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

  requireAgentNodeRun(projectId: string, id: string): WorkflowNodeRunRecord {
    const node = this.nodes.get(storageKey(projectId, id))
    if (!node) {
      throw new WorkflowRunError(
        `[Sixb] Workflow node run '${id}' not found for project '${projectId}'.`
      )
    }
    if (node.nodeType !== "agent") {
      throw new WorkflowRunError(`[Sixb] Workflow node run '${id}' is not an agent node.`)
    }
    return node
  }
}

export class InMemoryWorkflowAgentNodeRunStorage implements WorkflowAgentNodeRunStorage {
  private readonly runs = new Map<string, WorkflowAgentNodeRunRecord>()

  constructor(
    private readonly nodes: {
      requireAgentNodeRun(projectId: string, id: string): WorkflowNodeRunRecord
      requireWorkflowRun(projectId: string, id: string): WorkflowRunRecord
    },
    private readonly executions: ExecutionStorage
  ) {}

  snapshot(): InMemoryWorkflowAgentNodeRunStorageSnapshot {
    return structuredClone(this.runs)
  }

  restore(snapshot: InMemoryWorkflowAgentNodeRunStorageSnapshot): void {
    this.runs.clear()
    for (const [key, record] of structuredClone(snapshot)) this.runs.set(key, record)
  }

  async create(input: CreateWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    const node = this.nodes.requireAgentNodeRun(input.projectId, input.nodeRunId)
    const workflowRun = this.nodes.requireWorkflowRun(input.projectId, node.workflowRunId)
    await assertWorkflowAgentNodeRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      nodeRunId: input.nodeRunId,
      agentId: input.agentId,
      parentExecutionId: workflowRun.executionId,
    })
    if (node.status !== "running") {
      throw new WorkflowRunError(
        `[Sixb] Agent workflow node run '${input.nodeRunId}' must be running when queued.`
      )
    }
    const key = storageKey(input.projectId, input.nodeRunId)
    if (this.runs.has(key)) {
      throw new WorkflowRunError(
        `[Sixb] Agent execution already exists for workflow node run '${input.nodeRunId}'.`
      )
    }
    if (
      [...this.runs.values()].some(
        (run) => run.projectId === input.projectId && run.executionId === input.executionId
      )
    ) {
      throw new WorkflowRunError(
        `[Sixb] Execution '${input.executionId}' already belongs to another Workflow Agent-node run.`
      )
    }
    const record: WorkflowAgentNodeRunRecord = {
      projectId: input.projectId,
      nodeRunId: input.nodeRunId,
      executionId: input.executionId,
      agentId: input.agentId,
      status: "queued",
      prompt: input.prompt,
      attempt: 0,
      createdAt: new Date(input.createdAt ?? new Date()),
    }
    this.runs.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async start(input: StartWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    const run = this.requireStatus(input.projectId, input.nodeRunId, "queued")
    const next: WorkflowAgentNodeRunRecord = {
      ...run,
      status: "running",
      ...(input.modelId ? { modelId: input.modelId } : {}),
      attempt: 1,
      execution: cloneRecord(input.execution),
      startedAt: new Date(input.startedAt ?? new Date()),
    }
    return this.save(next)
  }

  async reclaim(input: ReclaimWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    const run = this.requireStatus(input.projectId, input.nodeRunId, "running")
    return this.save({ ...run, attempt: run.attempt + 1, execution: cloneRecord(input.execution) })
  }

  async confirmExecutionOwnership(
    input: ConfirmWorkflowAgentNodeRunExecutionOwnershipInput
  ): Promise<WorkflowAgentNodeRunRecord> {
    const run = this.requireOwned(input.projectId, input.nodeRunId, input.executionToken)
    return this.save({
      ...run,
      execution: {
        token: input.executionToken,
        queueLeaseExpiresAt: new Date(
          Math.max(
            run.execution!.queueLeaseExpiresAt.getTime(),
            input.queueLeaseExpiresAt.getTime()
          )
        ),
      },
    })
  }

  async finish(input: FinishWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    const run = this.requireOwned(input.projectId, input.nodeRunId, input.executionToken)
    return this.save({
      ...run,
      status: input.status,
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
      ...(input.usage === undefined ? {} : { usage: cloneRecord(input.usage) }),
      ...(input.trace === undefined ? {} : { trace: cloneRecord(input.trace) }),
      ...(input.diagnostics === undefined ? {} : { diagnostics: cloneRecord(input.diagnostics) }),
      ...(input.status === "succeeded" || input.error === undefined ? {} : { error: input.error }),
      execution: undefined,
      completedAt: new Date(input.completedAt ?? new Date()),
    })
  }

  async cancel(input: CancelWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    const run = this.requireExisting(input.projectId, input.nodeRunId)
    if (run.status !== "queued" && run.status !== "running") {
      throw new WorkflowRunError(
        `[Sixb] Agent workflow node run '${input.nodeRunId}' cannot be cancelled from status '${run.status}'.`
      )
    }
    return this.save({
      ...run,
      status: "cancelled",
      execution: undefined,
      error: input.error,
      completedAt: new Date(input.completedAt ?? new Date()),
    })
  }

  async getByNodeRunId(params: {
    projectId: string
    nodeRunId: string
  }): Promise<WorkflowAgentNodeRunRecord | null> {
    const run = this.runs.get(storageKey(params.projectId, params.nodeRunId))
    return run ? cloneRecord(run) : null
  }

  async list(input: ListWorkflowAgentNodeRunsInput): Promise<ListWorkflowAgentNodeRunsResult> {
    const statuses = input.statuses ? new Set(input.statuses) : null
    const order = input.order ?? "desc"
    const filtered = [...this.runs.values()]
      .filter((run) => run.projectId === input.projectId)
      .filter((run) => (input.agentId ? run.agentId === input.agentId : true))
      .filter((run) => (statuses ? statuses.has(run.status) : true))
      .sort((a, b) =>
        order === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime()
      )
    const { page, total, hasMore } = paginate(filtered, input)
    return { runs: page.map(cloneRecord), total, hasMore }
  }

  private requireStatus(
    projectId: string,
    nodeRunId: string,
    status: WorkflowAgentNodeRunRecord["status"]
  ): WorkflowAgentNodeRunRecord {
    const run = this.runs.get(storageKey(projectId, nodeRunId))
    if (!run) throw new WorkflowRunError(`[Sixb] Agent workflow node run '${nodeRunId}' not found.`)
    if (run.status !== status) {
      throw new WorkflowRunError(
        `[Sixb] Agent workflow node run '${nodeRunId}' must be ${status} (status '${run.status}').`
      )
    }
    return run
  }

  private requireExisting(projectId: string, nodeRunId: string): WorkflowAgentNodeRunRecord {
    const run = this.runs.get(storageKey(projectId, nodeRunId))
    if (!run) {
      throw new WorkflowRunError(
        `[Sixb] Agent workflow node run '${nodeRunId}' not found for project '${projectId}'.`
      )
    }
    return run
  }

  private requireOwned(
    projectId: string,
    nodeRunId: string,
    token: string
  ): WorkflowAgentNodeRunRecord {
    const run = this.requireStatus(projectId, nodeRunId, "running")
    if (run.execution?.token !== token) {
      throw new WorkflowRunError(
        `[Sixb] Execution token is no longer current on agent workflow node run '${nodeRunId}'.`
      )
    }
    return run
  }

  private save(record: WorkflowAgentNodeRunRecord): WorkflowAgentNodeRunRecord {
    this.runs.set(storageKey(record.projectId, record.nodeRunId), cloneRecord(record))
    return cloneRecord(record)
  }
}

export interface InMemoryWorkflowRunStorageSnapshot {
  readonly runs: Map<string, WorkflowRunRecord>
  readonly nodes: InMemoryWorkflowNodeRunStorageSnapshot
  readonly agentNodes: InMemoryWorkflowAgentNodeRunStorageSnapshot
}

export type InMemoryWorkflowNodeRunStorageSnapshot = Map<string, WorkflowNodeRunRecord>
export type InMemoryWorkflowAgentNodeRunStorageSnapshot = Map<string, WorkflowAgentNodeRunRecord>
