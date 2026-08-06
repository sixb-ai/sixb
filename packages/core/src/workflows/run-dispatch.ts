import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { SYSTEM_PRINCIPAL } from "../auth"
import { reportRunFailure } from "../error-reporting/capability"
import { captureSixbFailure } from "../errors/internal"
import type { DomainEventLog } from "../events"
import type { RunDispatcher } from "../execution/dispatch"
import { createPrimitiveExecutionRecord } from "../execution/durable"
import type { ValueType } from "../ontology"
import type { Queues } from "../queues"
import type { SixbDefinitions } from "../runtime/definitions"
import type { CreateExecutionInput, Storage, WorkflowRunRecord } from "../storage"
import { WORKFLOW_RUN_FAILURE_CODES, WorkflowRunError } from "../storage"
import { WorkflowValidationError } from "./errors"
import type { WorkflowRunRequestResult } from "./request"
import { snapshotWorkflowInput } from "./snapshot"
import type { WorkflowDefinition, WorkflowIOSnapshot, WorkflowRunSource } from "./types"

export type AutomaticWorkflowExecutionSource =
  | { readonly type: "schedule"; readonly eventId: string }
  | { readonly type: "event"; readonly eventId: string }

/** One automatic match already resolved to a stable workflow run identity by the orchestrator. */
export interface AutomaticWorkflowRunDispatchInput {
  readonly workflowId: string
  readonly runId: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly scheduleId: string
  readonly source: AutomaticWorkflowExecutionSource
  readonly correlationId: string
  readonly metadata?: Readonly<Record<string, string>>
}

export type WorkflowRunDispatchPort = RunDispatcher<
  AutomaticWorkflowRunDispatchInput,
  WorkflowRunRequestResult
>

export interface WorkflowRunDispatcherDependencies {
  readonly id: string
  readonly definitions: Pick<SixbDefinitions, "ontology" | "workflows">
  readonly storage: Storage
  readonly queues: Pick<Queues, "workflows">
  readonly events: DomainEventLog
}

interface DispatchWorkflowRunInput {
  readonly errorReporterHost: object
  readonly projectId: string
  readonly workflow: WorkflowDefinition
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly storage: Storage
  readonly queue: Queues["workflows"]
  readonly events: DomainEventLog
  readonly runId?: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly source?: WorkflowRunSource
  readonly requesterGroupIds: readonly string[]
  readonly metadata?: Readonly<Record<string, string>>
  readonly queueJobId?: string
  readonly createExecution: (executionId: string, runId: string) => Promise<CreateExecutionInput>
}

interface PreparedWorkflowRun {
  readonly runId: string
  readonly snapshot: WorkflowIOSnapshot
}

type PersistedWorkflowRun =
  | {
      readonly created: false
      readonly run: WorkflowRunRecord
    }
  | {
      readonly created: true
      readonly run: WorkflowRunRecord
      readonly execution: CreateExecutionInput
      readonly queuedAt: Date
    }

/** Core-owned durable dispatch boundary used by automatic trigger runtimes. */
export class WorkflowRunDispatcher implements WorkflowRunDispatchPort {
  constructor(private readonly dependencies: WorkflowRunDispatcherDependencies) {}

  async dispatch(input: AutomaticWorkflowRunDispatchInput): Promise<WorkflowRunRequestResult> {
    assertAutomaticDispatchInput(input)
    const workflow = this.dependencies.definitions.workflows.getById(input.workflowId)
    if (!workflow) {
      throw new WorkflowValidationError(`[Sixb] Unknown workflow '${input.workflowId}'`)
    }

    const result = await dispatchWorkflowRun({
      errorReporterHost: this.dependencies,
      projectId: this.dependencies.id,
      workflow,
      valueTypesById: this.dependencies.definitions.ontology.getValueTypesById(),
      storage: this.dependencies.storage,
      queue: this.dependencies.queues.workflows,
      events: this.dependencies.events,
      runId: input.runId,
      input: input.input,
      source: {
        type: "schedule",
        scheduleId: input.scheduleId,
        eventId: input.source.eventId,
        principal: SYSTEM_PRINCIPAL,
      },
      requesterGroupIds: [],
      metadata: input.metadata,
      queueJobId: input.runId,
      createExecution: async (executionId, runId) =>
        createPrimitiveExecutionRecord({
          id: executionId,
          primitive: { kind: "workflow", id: workflow.id, runId },
          origin: {
            type: "automatic",
            projectId: this.dependencies.id,
            source: input.source,
            correlationId: input.correlationId,
          },
        }),
    })
    if (!result.created) {
      await assertAutomaticExecutionIdentity(this.dependencies, input, result.runId)
    }
    return result
  }
}

/** Persist a workflow execution and run before publishing its queue job. */
export async function dispatchWorkflowRun(
  input: DispatchWorkflowRunInput
): Promise<WorkflowRunRequestResult> {
  const request = prepareWorkflowRun(input)
  const persisted = await persistWorkflowRun(input, request)
  if (!persisted.created) return existingWorkflowRunResult(persisted.run)
  return publishWorkflowRun(input, persisted)
}

function prepareWorkflowRun(input: DispatchWorkflowRunInput): PreparedWorkflowRun {
  const value = input.input ?? {}
  return {
    runId: resolveWorkflowRunId(input.runId),
    snapshot: snapshotWorkflowInput({
      workflow: input.workflow,
      value,
      valueTypesById: input.valueTypesById,
    }),
  }
}

async function persistWorkflowRun(
  input: DispatchWorkflowRunInput,
  request: PreparedWorkflowRun
): Promise<PersistedWorkflowRun> {
  const workflowRuns = input.storage.workflowRuns
  if (!workflowRuns) {
    throw new WorkflowValidationError("[Sixb] Workflow run storage is not configured.")
  }

  const existing = await workflowRuns.getById({
    projectId: input.projectId,
    id: request.runId,
  })
  if (existing) {
    assertExistingWorkflowRun(existing, input.workflow.id, request.snapshot)
    return { run: existing, created: false }
  }

  const execution = await input.createExecution(`exec_${randomUUID()}`, request.runId)
  const queuedAt = new Date()
  try {
    return await input.storage.transaction(
      async (tx): Promise<PersistedWorkflowRun> => {
        const raced = await tx.workflowRuns?.getById({
          projectId: input.projectId,
          id: request.runId,
        })
        if (raced) {
          assertExistingWorkflowRun(raced, input.workflow.id, request.snapshot)
          return { run: raced, created: false }
        }
        if (!tx.workflowRuns) {
          throw new WorkflowValidationError("[Sixb] Workflow run storage is not configured.")
        }

        await tx.executions.create(execution)
        const run = await tx.workflowRuns.queue({
          projectId: input.projectId,
          id: request.runId,
          executionId: execution.id,
          workflowId: input.workflow.id,
          input: request.snapshot,
          queuedAt,
          requesterGroupIds: input.requesterGroupIds,
        })
        return { run, execution, queuedAt, created: true }
      },
      { isolation: "serializable" }
    )
  } catch (error) {
    if (!(error instanceof WorkflowRunError)) throw error
    const raced = await workflowRuns.getById({
      projectId: input.projectId,
      id: request.runId,
    })
    if (!raced) throw error
    assertExistingWorkflowRun(raced, input.workflow.id, request.snapshot)
    return { run: raced, created: false }
  }
}

async function publishWorkflowRun(
  input: DispatchWorkflowRunInput,
  persisted: Extract<PersistedWorkflowRun, { readonly created: true }>
): Promise<WorkflowRunRequestResult> {
  let job: Awaited<ReturnType<Queues["workflows"]["enqueue"]>>[number] | undefined
  try {
    const jobs = await input.queue.enqueue({
      projectId: input.projectId,
      jobs: [
        {
          ...(input.queueJobId === undefined ? {} : { id: input.queueJobId }),
          type: "workflow.run.requested",
          payload: { runId: persisted.run.id },
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      ],
    })
    job = jobs[0]
  } catch (error) {
    await failWorkflowRunPublication(input, persisted.run, error)
    throw error
  }

  await input.events.emit(
    {
      events: [
        {
          type: "workflow.run.queued",
          payload: {
            workflowId: persisted.run.workflowId,
            runId: persisted.run.id,
            queuedAt: persisted.queuedAt.toISOString(),
            ...(job?.id ? { jobId: job.id } : {}),
            ...(input.source === undefined ? {} : { source: input.source }),
          },
        },
      ],
      correlationId: persisted.execution.correlationId,
    },
    { source: "Sixb" }
  )

  return {
    workflowId: persisted.run.workflowId,
    runId: persisted.run.id,
    queuedAt: persisted.queuedAt.toISOString(),
    jobId: job?.id,
    created: true,
  }
}

async function failWorkflowRunPublication(
  input: DispatchWorkflowRunInput,
  run: WorkflowRunRecord,
  error: unknown
): Promise<void> {
  const workflowRuns = input.storage.workflowRuns
  if (!workflowRuns) {
    throw new WorkflowValidationError("[Sixb] Workflow run storage is not configured.")
  }
  const failed = await workflowRuns.finish({
    projectId: input.projectId,
    id: run.id,
    status: "failed",
    error: captureSixbFailure(error, {
      allowedCodes: WORKFLOW_RUN_FAILURE_CODES,
      defaultCode: "internal.unexpected",
      details: { workflowId: run.workflowId, runId: run.id },
    }),
  })
  reportRunFailure(input.errorReporterHost, error, {
    projectId: input.projectId,
    occurredAt: failed.finishedAt,
    run: { kind: "workflow", runId: run.id, workflowId: run.workflowId },
  })
}

function resolveWorkflowRunId(runId: string | undefined): string {
  if (runId === undefined) return `run_${randomUUID()}`
  if (!runId.trim()) {
    throw new WorkflowValidationError("[Sixb] Workflow run id must not be empty")
  }
  return runId
}

function assertExistingWorkflowRun(
  existing: WorkflowRunRecord,
  workflowId: string,
  input: WorkflowRunRecord["input"]
): void {
  if (existing.workflowId !== workflowId || !isDeepStrictEqual(existing.input, input)) {
    throw new WorkflowValidationError(
      `[Sixb] Workflow run '${existing.id}' already exists with a different request payload.`
    )
  }
}

function existingWorkflowRunResult(existing: WorkflowRunRecord): WorkflowRunRequestResult {
  return {
    workflowId: existing.workflowId,
    runId: existing.id,
    queuedAt: (existing.queuedAt ?? existing.startedAt).toISOString(),
    created: false,
  }
}

function assertAutomaticDispatchInput(input: AutomaticWorkflowRunDispatchInput): void {
  assertNonBlank(input.workflowId, "Workflow id")
  assertNonBlank(input.runId, "Workflow run id")
  assertNonBlank(input.scheduleId, "Workflow schedule id")
  assertNonBlank(input.source.eventId, "Workflow source event id")
  assertNonBlank(input.correlationId, "Workflow correlation id")
}

async function assertAutomaticExecutionIdentity(
  dependencies: WorkflowRunDispatcherDependencies,
  input: AutomaticWorkflowRunDispatchInput,
  runId: string
): Promise<void> {
  const run = await dependencies.storage.workflowRuns?.getById({
    projectId: dependencies.id,
    id: runId,
  })
  const execution = run
    ? await dependencies.storage.executions.getById({
        projectId: dependencies.id,
        id: run.executionId,
      })
    : null
  if (
    !execution ||
    execution.source.type !== input.source.type ||
    execution.source.eventId !== input.source.eventId ||
    execution.correlationId !== input.correlationId ||
    execution.parentExecutionId !== undefined ||
    execution.requestedBy !== undefined
  ) {
    throw new WorkflowValidationError(
      `[Sixb] Workflow run '${runId}' already exists with different automatic provenance.`
    )
  }
}

function assertNonBlank(value: string, label: string): void {
  if (!value.trim()) throw new WorkflowValidationError(`[Sixb] ${label} must not be empty.`)
}
