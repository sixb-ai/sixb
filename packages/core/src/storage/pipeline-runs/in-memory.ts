import { parseSixbFailure } from "../../errors/internal"
import type { SixbFailure } from "../../errors/types"
import type { ExecutionStorage } from "../executions"
import {
  type ClaimRunInput,
  type ConfirmRunExecutionInput,
  holdsRun,
  type ListLostRunsInput,
  laterLease,
  mayFinishRun,
  planRunClaim,
  type ReleaseRunExecutionInput,
  type RunClaim,
  selectLostRuns,
} from "../run-claim"
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
import { PipelineRunError } from "./errors"
import { canRequeuePipelineRunAfterEnqueueFailure } from "./idempotency"
import { assertPipelineRunExecution } from "./provider"
import { canFinishPipelineRun } from "./transitions"
import type {
  FinishPipelineRunInput,
  FinishPipelineStepRunInput,
  ListLatestPipelineRunsInput,
  ListLatestPipelineRunsResult,
  ListPipelineRunsInput,
  ListPipelineRunsResult,
  ListPipelineStepRunsInput,
  ListPipelineStepRunsResult,
  PipelineRunFailureCode,
  PipelineRunRecord,
  PipelineRunStorage,
  PipelineStepRunRecord,
  QueuePipelineRunInput,
  StartPipelineStepRunInput,
} from "./types"
import { PIPELINE_RUN_FAILURE_CODES } from "./types"

function normalizeError(
  error: SixbFailure<PipelineRunFailureCode> | undefined
): SixbFailure<PipelineRunFailureCode> | undefined {
  return error ? parseSixbFailure(error, PIPELINE_RUN_FAILURE_CODES) : undefined
}

function assertNonNegativeInteger(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new PipelineRunError(`[Sixb] Pipeline run ${fieldName} must be a non-negative integer.`)
  }
}

export class InMemoryPipelineRunStorage implements PipelineRunStorage {
  private readonly runs = new Map<string, PipelineRunRecord>()
  private readonly steps = new Map<string, PipelineStepRunRecord>()

  constructor(private readonly executions: ExecutionStorage) {}

  snapshot(): InMemoryPipelineRunStorageSnapshot {
    return {
      runs: structuredClone(this.runs),
      steps: structuredClone(this.steps),
    }
  }

  restore(snapshot: InMemoryPipelineRunStorageSnapshot): void {
    this.runs.clear()
    for (const [key, record] of structuredClone(snapshot.runs)) {
      this.runs.set(key, record)
    }

    this.steps.clear()
    for (const [key, record] of structuredClone(snapshot.steps)) {
      this.steps.set(key, record)
    }
  }

  async queue(input: QueuePipelineRunInput): Promise<PipelineRunRecord> {
    const key = storageKey(input.projectId, input.id)
    const existing = this.runs.get(key)
    if (existing && !canRequeuePipelineRunAfterEnqueueFailure(existing, input)) {
      throw new PipelineRunError(
        `[Sixb] Pipeline run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }
    if (
      [...this.runs.values()].some(
        (run) =>
          run.projectId === input.projectId &&
          run.id !== input.id &&
          run.executionId === input.executionId
      )
    ) {
      throw new PipelineRunError(
        `[Sixb] Execution '${input.executionId}' already belongs to another Pipeline run.`
      )
    }
    await assertPipelineRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      pipelineId: input.pipelineId,
    })

    const queuedAt = new Date(input.queuedAt ?? new Date())
    if (existing) {
      const next: PipelineRunRecord = {
        ...existing,
        status: "queued",
        attempt: 0,
        execution: undefined,
        queuedAt,
        startedAt: undefined,
        finishedAt: undefined,
        output: undefined,
        error: undefined,
      }
      this.runs.set(key, cloneRecord(next))
      return cloneRecord(next)
    }

    const record: PipelineRunRecord = {
      id: input.id,
      projectId: input.projectId,
      executionId: input.executionId,
      pipelineId: input.pipelineId,
      status: "queued",
      attempt: 0,
      queuedAt,
    }

    this.runs.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async startOrReclaim(input: ClaimRunInput): Promise<RunClaim<PipelineRunRecord>> {
    const existing = this.requireExistingPipelineRun(input.projectId, input.id)

    const plan = planRunClaim(cloneRecord(existing), input)
    if (!plan.take) return plan.claim

    const { outcome, startedAt, attempt, execution } = plan
    const run = this.writeRun({
      ...existing,
      status: "running",
      startedAt,
      attempt,
      execution,
      error: undefined,
    })
    return { outcome, run }
  }

  async confirmExecutionOwnership(input: ConfirmRunExecutionInput): Promise<PipelineRunRecord> {
    const existing = this.requireHeldPipelineRun(input.projectId, input.id, input.executionToken)

    return this.writeRun({
      ...existing,
      execution: {
        token: input.executionToken,
        queueLeaseExpiresAt: laterLease(
          existing.execution?.queueLeaseExpiresAt,
          input.queueLeaseExpiresAt
        ),
      },
    })
  }

  async listLost(input: ListLostRunsInput): Promise<readonly PipelineRunRecord[]> {
    return selectLostRuns(this.runs.values(), input).map((run) => cloneRecord(run))
  }

  async releaseExecution(input: ReleaseRunExecutionInput): Promise<void> {
    const existing = this.runs.get(storageKey(input.projectId, input.id))
    if (existing?.status !== "running" || existing.execution?.token !== input.executionToken) return

    this.writeRun({
      ...existing,
      execution: {
        token: input.executionToken,
        queueLeaseExpiresAt: new Date(input.releasedAt ?? new Date()),
      },
      attempt: input.spentAttempt ? existing.attempt : existing.attempt - 1,
    })
  }

  async finish(input: FinishPipelineRunInput): Promise<PipelineRunRecord> {
    const existing = this.requireExistingPipelineRun(input.projectId, input.id)
    if (!canFinishPipelineRun(existing.status, input)) {
      throw new PipelineRunError(
        `[Sixb] Pipeline run '${input.id}' cannot finish from status '${existing.status}'.`
      )
    }
    if (!mayFinishRun(existing, input)) throw staleExecution(input.id)

    const base: PipelineRunRecord = {
      ...existing,
      status: input.status,
      execution: undefined,
      finishedAt: new Date(input.finishedAt ?? new Date()),
    }

    const next: PipelineRunRecord =
      input.status === "succeeded"
        ? {
            ...base,
            output: input.output ? cloneRecord(input.output) : undefined,
            error: undefined,
          }
        : {
            ...base,
            output: undefined,
            error: normalizeError(input.error),
          }

    return this.writeRun(next)
  }

  async startStep(input: StartPipelineStepRunInput): Promise<PipelineStepRunRecord> {
    const pipelineRun = this.requireRunningPipelineRun(input.projectId, input.pipelineRunId)
    if (!holdsRun(pipelineRun, input.executionToken)) throw staleExecution(input.pipelineRunId)

    if (pipelineRun.pipelineId !== input.pipelineId) {
      throw new PipelineRunError(
        `[Sixb] Pipeline step run '${input.id}' pipeline '${input.pipelineId}' does not match pipeline run '${input.pipelineRunId}' pipeline '${pipelineRun.pipelineId}'.`
      )
    }

    const key = storageKey(input.projectId, input.id)
    const earlier = this.steps.get(key)
    if (earlier && earlier.status !== "running") {
      throw new PipelineRunError(
        `[Sixb] Pipeline step run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const record: PipelineStepRunRecord = {
      id: input.id,
      projectId: input.projectId,
      pipelineRunId: input.pipelineRunId,
      pipelineId: input.pipelineId,
      stepId: input.stepId,
      datasetId: input.datasetId,
      mode: input.mode,
      status: "running",
      startedAt: earlier?.startedAt ?? new Date(input.startedAt ?? new Date()),
      inputs: cloneRecord(input.inputs),
    }

    this.steps.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async finishStep(input: FinishPipelineStepRunInput): Promise<PipelineStepRunRecord> {
    assertNonNegativeInteger(input.rowsWritten, "rowsWritten")

    const existing = this.requireRunningStepRun(input.projectId, input.id)

    const pipelineRun = this.requireExistingPipelineRun(input.projectId, existing.pipelineRunId)
    if (!holdsRun(pipelineRun, input.executionToken)) {
      throw staleExecution(existing.pipelineRunId)
    }

    if (input.status === "succeeded" && input.output.datasetId !== existing.datasetId) {
      throw new PipelineRunError(
        `[Sixb] Pipeline step run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.datasetId}'.`
      )
    }

    const base: PipelineStepRunRecord = {
      ...existing,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
      rowsWritten: input.rowsWritten ?? existing.rowsWritten,
    }

    const next: PipelineStepRunRecord =
      input.status === "succeeded"
        ? {
            ...base,
            output: cloneRecord(input.output),
            error: undefined,
          }
        : {
            ...base,
            output: undefined,
            error: normalizeError(input.error),
          }

    this.steps.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<PipelineRunRecord | null> {
    const record = this.runs.get(storageKey(params.projectId, params.id))
    return record ? cloneRecord(record) : null
  }

  async list(input: ListPipelineRunsInput): Promise<ListPipelineRunsResult> {
    if (hasEmptyStatuses(input) || input.pipelineIds?.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const order = input.order ?? "desc"
    const statuses = toStatusSet(input.statuses)
    const pipelineIds = input.pipelineIds ? new Set(input.pipelineIds) : null
    const filtered = [...this.runs.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => (input.pipelineId ? record.pipelineId === input.pipelineId : true))
      .filter((record) => (pipelineIds ? pipelineIds.has(record.pipelineId) : true))
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

  async listLatestByPipelineIds(
    input: ListLatestPipelineRunsInput
  ): Promise<ListLatestPipelineRunsResult> {
    const runs = latestStartedAtByOwnerId(
      [...this.runs.values()].filter(
        (record) => record.projectId === input.projectId && record.status !== input.excludedStatus
      ),
      input.pipelineIds,
      (record) => record.pipelineId
    )

    return {
      runs: runs.map(cloneRecord),
    }
  }

  async listSteps(input: ListPipelineStepRunsInput): Promise<ListPipelineStepRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        steps: [],
        hasMore: false,
        total: 0,
      }
    }

    const order = input.order ?? "desc"
    const statuses = toStatusSet(input.statuses)
    const filtered = [...this.steps.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) =>
        input.pipelineRunId ? record.pipelineRunId === input.pipelineRunId : true
      )
      .filter((record) => input.pipelineRunIds?.includes(record.pipelineRunId) ?? true)
      .filter((record) => (input.pipelineId ? record.pipelineId === input.pipelineId : true))
      .filter((record) => (input.stepId ? record.stepId === input.stepId : true))
      .filter((record) => (input.datasetId ? record.datasetId === input.datasetId : true))
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
      steps: page.map(cloneRecord),
      hasMore,
      total,
    }
  }

  private requireExistingPipelineRun(projectId: string, id: string): PipelineRunRecord {
    const record = this.runs.get(storageKey(projectId, id))
    if (!record) {
      throw new PipelineRunError(
        `[Sixb] Pipeline run '${id}' not found for project '${projectId}'.`
      )
    }

    return record
  }

  private requireHeldPipelineRun(projectId: string, id: string, token: string): PipelineRunRecord {
    const existing = this.requireExistingPipelineRun(projectId, id)
    if (existing.status !== "running" || existing.execution?.token !== token) {
      throw staleExecution(id)
    }
    return existing
  }

  private writeRun(run: PipelineRunRecord): PipelineRunRecord {
    this.runs.set(storageKey(run.projectId, run.id), cloneRecord(run))
    return cloneRecord(run)
  }

  private requireRunningPipelineRun(projectId: string, id: string): PipelineRunRecord {
    const record = this.requireExistingPipelineRun(projectId, id)
    if (record.status !== "running") {
      throw new PipelineRunError(
        `[Sixb] Pipeline run '${id}' for project '${projectId}' is already terminal.`
      )
    }

    return record
  }

  private requireRunningStepRun(projectId: string, id: string): PipelineStepRunRecord {
    const record = this.steps.get(storageKey(projectId, id))
    if (!record) {
      throw new PipelineRunError(
        `[Sixb] Pipeline step run '${id}' not found for project '${projectId}'.`
      )
    }

    if (record.status !== "running") {
      throw new PipelineRunError(
        `[Sixb] Pipeline step run '${id}' for project '${projectId}' is already terminal.`
      )
    }

    return record
  }
}

function staleExecution(id: string): PipelineRunError {
  return new PipelineRunError(
    `[Sixb] Execution token is no longer current on pipeline run '${id}'.`
  )
}

export interface InMemoryPipelineRunStorageSnapshot {
  readonly runs: Map<string, PipelineRunRecord>
  readonly steps: Map<string, PipelineStepRunRecord>
}
