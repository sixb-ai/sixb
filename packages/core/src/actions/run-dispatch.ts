import { randomUUID } from "node:crypto"
import { reportRunFailure } from "../error-reporting/capability"
import type { DomainEventLog } from "../events"
import type { Queues } from "../queues"
import type { ActionRunParams, ActionRunRecord, CreateExecutionInput, Storage } from "../storage"
import { ActionRunError, actionRunParamsEqual, actionSubjectsEqual } from "../storage"
import type { RequestActionResult } from "./request"
import { createActionRunId, createActionRunIdempotencyKey } from "./run-id"
import type { ActionSubject } from "./types"

interface DispatchActionRunInput {
  readonly errorReporterHost: object
  readonly projectId: string
  readonly storage: Storage
  readonly queue: Queues["actions"]
  readonly events: DomainEventLog
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: ActionRunParams
  readonly runId?: string
  readonly createExecution: (executionId: string, runId: string) => Promise<CreateExecutionInput>
}

interface PreparedActionRun {
  readonly runId: string
  readonly idempotencyKey: string
}

type PersistedActionRun =
  | { readonly publish: false; readonly run: ActionRunRecord }
  | {
      readonly publish: true
      readonly run: ActionRunRecord
      readonly execution: CreateExecutionInput
      readonly queuedAt: Date
      readonly created: boolean
    }

/** Persist an Action execution and run before publishing its queue job. */
export async function dispatchActionRun(
  input: DispatchActionRunInput
): Promise<RequestActionResult> {
  const request = prepareActionRun(input)
  const persisted = await persistActionRun(input, request)
  if (!persisted.publish) return existingActionRunResult(persisted.run)
  return publishActionRun(input, persisted)
}

function prepareActionRun(input: DispatchActionRunInput): PreparedActionRun {
  const runId = createActionRunId(input.runId)
  return {
    runId,
    idempotencyKey: createActionRunIdempotencyKey(input.projectId, runId),
  }
}

async function persistActionRun(
  input: DispatchActionRunInput,
  request: PreparedActionRun
): Promise<PersistedActionRun> {
  const actionRuns = requireActionRunStorage(input.storage)
  const existing = await actionRuns.getById({ projectId: input.projectId, id: request.runId })
  if (existing) return reuseActionRun(input, existing)

  const execution = await input.createExecution(`exec_${randomUUID()}`, request.runId)
  const queuedAt = new Date()
  try {
    return await input.storage.transaction(
      async (tx): Promise<PersistedActionRun> => {
        const transactionalRuns = requireActionRunStorage(tx)
        const raced = await transactionalRuns.getById({
          projectId: input.projectId,
          id: request.runId,
        })
        if (raced) {
          assertExistingRunMatchesRequest(raced, input)
          return { publish: false, run: raced }
        }

        await tx.executions.create(execution)
        const run = await transactionalRuns.queue({
          projectId: input.projectId,
          id: request.runId,
          executionId: execution.id,
          actionId: input.actionId,
          subject: input.subject,
          params: input.params,
          idempotencyKey: request.idempotencyKey,
          queuedAt,
        })
        return { publish: true, run, execution, queuedAt, created: true }
      },
      { isolation: "serializable" }
    )
  } catch (error) {
    if (!(error instanceof ActionRunError)) throw error
    const raced = await actionRuns.getById({ projectId: input.projectId, id: request.runId })
    if (!raced) throw error
    assertExistingRunMatchesRequest(raced, input)
    return { publish: false, run: raced }
  }
}

async function reuseActionRun(
  input: DispatchActionRunInput,
  existing: ActionRunRecord
): Promise<PersistedActionRun> {
  assertExistingRunMatchesRequest(existing, input)
  if (!isRetryableEnqueueFailure(existing)) return { publish: false, run: existing }

  const execution = await input.storage.executions.getById({
    projectId: input.projectId,
    id: existing.executionId,
  })
  if (!execution) {
    throw new ActionRunError(
      `[Sixb] Execution '${existing.executionId}' for Action run '${existing.id}' was not found.`
    )
  }

  const queuedAt = new Date()
  const run = await requireActionRunStorage(input.storage).queue({
    projectId: input.projectId,
    id: existing.id,
    executionId: existing.executionId,
    actionId: existing.actionId,
    subject: existing.subject,
    params: existing.params,
    idempotencyKey: existing.idempotencyKey,
    queuedAt,
  })
  return { publish: true, run, execution, queuedAt, created: false }
}

async function publishActionRun(
  input: DispatchActionRunInput,
  persisted: Extract<PersistedActionRun, { readonly publish: true }>
): Promise<RequestActionResult> {
  let job: Awaited<ReturnType<Queues["actions"]["enqueue"]>>[number] | undefined
  try {
    const jobs = await input.queue.enqueue({
      projectId: input.projectId,
      jobs: [
        {
          id: persisted.run.id,
          type: "action.run.requested",
          payload: {
            runId: persisted.run.id,
          },
        },
      ],
    })
    job = jobs[0]
  } catch (error) {
    await failActionRunPublication(input, persisted.run, error)
    throw error
  }

  await input.events.emit(
    {
      events: [
        {
          type: "action.requested",
          payload: {
            actionId: persisted.run.actionId,
            subject: persisted.run.subject,
            params: persisted.run.params,
            runId: persisted.run.id,
          },
        },
      ],
      correlationId: persisted.execution.correlationId,
    },
    { source: "Sixb" }
  )

  return {
    runId: persisted.run.id,
    queuedAt: persisted.queuedAt.toISOString(),
    ...(job?.id ? { jobId: job.id } : {}),
    created: persisted.created,
  }
}

async function failActionRunPublication(
  input: DispatchActionRunInput,
  run: ActionRunRecord,
  error: unknown
): Promise<void> {
  const failed = await requireActionRunStorage(input.storage).finish({
    projectId: input.projectId,
    id: run.id,
    status: "failed",
    phase: "enqueue",
    error: toActionRunFailure(error),
  })
  reportRunFailure(input.errorReporterHost, error, {
    projectId: input.projectId,
    occurredAt: failed.finishedAt,
    run: { kind: "action", runId: run.id, actionId: run.actionId },
  })
}

function requireActionRunStorage(storage: Storage): NonNullable<Storage["actionRuns"]> {
  if (!storage.actionRuns) {
    throw new ActionRunError("[Sixb] Action run storage is not configured.")
  }
  return storage.actionRuns
}

function assertExistingRunMatchesRequest(
  existing: ActionRunRecord,
  request: Pick<DispatchActionRunInput, "actionId" | "subject" | "params">
): void {
  if (
    existing.actionId !== request.actionId ||
    !actionSubjectsEqual(existing.subject, request.subject) ||
    !actionRunParamsEqual(existing.params, request.params)
  ) {
    throw new ActionRunError(
      `[Sixb] Action run '${existing.id}' already exists with a different request payload.`
    )
  }
}

function isRetryableEnqueueFailure(record: ActionRunRecord): boolean {
  return record.status === "failed" && record.phase === "enqueue"
}

function existingActionRunResult(existing: ActionRunRecord): RequestActionResult {
  return {
    runId: existing.id,
    queuedAt: existing.queuedAt.toISOString(),
    created: false,
  }
}

function toActionRunFailure(error: unknown): { name?: string; message: string; phase: "enqueue" } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, phase: "enqueue" }
  }
  return { message: String(error), phase: "enqueue" }
}
