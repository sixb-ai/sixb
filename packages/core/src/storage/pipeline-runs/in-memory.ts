import type { SixbFailure } from "../../errors"
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
import type {
  FinishPipelineRunInput,
  FinishPipelineStepRunInput,
  ListLatestPipelineRunsInput,
  ListLatestPipelineRunsResult,
  ListPipelineRunsInput,
  ListPipelineRunsResult,
  ListPipelineStepRunsInput,
  ListPipelineStepRunsResult,
  PipelineRunRecord,
  PipelineRunStorage,
  PipelineStepRunRecord,
  StartPipelineRunInput,
  StartPipelineStepRunInput,
} from "./types"

function normalizeError(error: SixbFailure | undefined): SixbFailure | undefined {
  return error ? cloneRecord(error) : undefined
}

function assertNonNegativeInteger(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new PipelineRunError(`[Sixb] Pipeline run ${fieldName} must be a non-negative integer.`)
  }
}

export class InMemoryPipelineRunStorage implements PipelineRunStorage {
  private readonly runs = new Map<string, PipelineRunRecord>()
  private readonly steps = new Map<string, PipelineStepRunRecord>()

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

  async start(input: StartPipelineRunInput): Promise<PipelineRunRecord> {
    const key = storageKey(input.projectId, input.id)
    if (this.runs.has(key)) {
      throw new PipelineRunError(
        `[Sixb] Pipeline run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const record: PipelineRunRecord = {
      id: input.id,
      projectId: input.projectId,
      pipelineId: input.pipelineId,
      status: "running",
      startedAt: new Date(input.startedAt ?? new Date()),
    }

    this.runs.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async finish(input: FinishPipelineRunInput): Promise<PipelineRunRecord> {
    const existing = this.requireRunningPipelineRun(input.projectId, input.id)
    const base: PipelineRunRecord = {
      ...existing,
      status: input.status,
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

    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async startStep(input: StartPipelineStepRunInput): Promise<PipelineStepRunRecord> {
    const pipelineRun = this.requireRunningPipelineRun(input.projectId, input.pipelineRunId)
    if (pipelineRun.pipelineId !== input.pipelineId) {
      throw new PipelineRunError(
        `[Sixb] Pipeline step run '${input.id}' pipeline '${input.pipelineId}' does not match pipeline run '${input.pipelineRunId}' pipeline '${pipelineRun.pipelineId}'.`
      )
    }

    const key = storageKey(input.projectId, input.id)
    if (this.steps.has(key)) {
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
      startedAt: new Date(input.startedAt ?? new Date()),
      inputs: cloneRecord(input.inputs),
    }

    this.steps.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async finishStep(input: FinishPipelineStepRunInput): Promise<PipelineStepRunRecord> {
    assertNonNegativeInteger(input.rowsWritten, "rowsWritten")

    const existing = this.requireRunningStepRun(input.projectId, input.id)

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
      [...this.runs.values()].filter((record) => record.projectId === input.projectId),
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

export interface InMemoryPipelineRunStorageSnapshot {
  readonly runs: Map<string, PipelineRunRecord>
  readonly steps: Map<string, PipelineStepRunRecord>
}
