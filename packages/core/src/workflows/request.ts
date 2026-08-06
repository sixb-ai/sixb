import { randomUUID } from "node:crypto"
import { SYSTEM_PRINCIPAL } from "../auth"
import { assertAuthorized } from "../authorization"
import { reportRunFailure } from "../error-reporting/capability"
import { toSixbFailure } from "../errors/internal"
import type { SixbRuntimeContext } from "../runtime/types"
import { WORKFLOW_RUN_FAILURE_CODES } from "../storage/workflow-runs"
import { WorkflowValidationError } from "./errors"
import { snapshotWorkflowInput } from "./snapshot"
import type { WorkflowDefinition, WorkflowRunSource } from "./types"

export interface WorkflowRunRequestOptions {
  readonly input?: Readonly<Record<string, unknown>>
  readonly runId?: string
  readonly source?: WorkflowRunSource
}

export interface RequestWorkflowRunInput extends WorkflowRunRequestOptions {
  readonly workflowId: string
}

export interface WorkflowRunRequestResult {
  readonly workflowId: string
  readonly runId: string
  readonly queuedAt: string
  readonly jobId?: string
  /**
   * `false` when a deterministic `runId` already existed for the same workflow,
   * so no second queue job was enqueued.
   */
  readonly created: boolean
}

/**
 * Validate, snapshot, persist, queue, and announce a workflow run request.
 *
 * Operates on an already-resolved workflow definition and the shared runtime
 * context, so it stays decoupled from how workflows are registered or looked up.
 */
export async function requestWorkflowRun(
  runtime: SixbRuntimeContext,
  workflow: WorkflowDefinition,
  options: WorkflowRunRequestOptions = {}
): Promise<WorkflowRunRequestResult> {
  assertAuthorized(runtime, { kind: "workflow.run", workflowId: workflow.id })
  const storage = runtime.storage.workflowRuns
  if (!storage) {
    throw new WorkflowValidationError("[Sixb] Workflow run storage is not configured.")
  }

  const queue = runtime.queues.workflows
  if (!queue) {
    throw new WorkflowValidationError("[Sixb] Workflow run queue is not configured.")
  }

  const runId = createWorkflowRunId(options.runId)
  const value = options.input ?? {}
  // Validates the input against the workflow contract and rejects before any
  // storage or queue write.
  const snapshot = snapshotWorkflowInput({
    workflow,
    value,
    valueTypesById: runtime.ontology.getValueTypesById(),
  })

  const existing = await storage.getById({ projectId: runtime.projectId, id: runId })
  if (existing) {
    if (existing.workflowId !== workflow.id) {
      throw new WorkflowValidationError(
        `[Sixb] Workflow run '${runId}' already exists for a different workflow '${existing.workflowId}'.`
      )
    }

    return {
      workflowId: workflow.id,
      runId,
      queuedAt: (existing.queuedAt ?? existing.startedAt).toISOString(),
      created: false,
    }
  }

  const queuedAt = new Date()
  await storage.queue({
    projectId: runtime.projectId,
    id: runId,
    workflowId: workflow.id,
    input: snapshot,
    queuedAt,
    source: options.source,
    requestedByPrincipal:
      runtime.authorization?.principal ??
      (options.source?.type === "schedule" ? options.source.principal : SYSTEM_PRINCIPAL),
  })

  let job: Awaited<ReturnType<typeof queue.enqueue>>[number] | undefined
  try {
    ;[job] = await queue.enqueue({
      projectId: runtime.projectId,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: { workflowId: workflow.id, runId, input: value },
        },
      ],
    })
  } catch (error) {
    const failed = await storage.finish({
      projectId: runtime.projectId,
      id: runId,
      status: "failed",
      error: toSixbFailure(error, {
        allowedCodes: WORKFLOW_RUN_FAILURE_CODES,
        fallbackCode: "internal.unexpected",
        fallbackDetails: { workflowId: workflow.id, runId },
      }),
    })
    reportRunFailure(runtime, error, {
      projectId: runtime.projectId,
      occurredAt: failed.finishedAt,
      run: {
        kind: "workflow",
        runId,
        workflowId: workflow.id,
      },
    })
    throw error
  }

  // Past this point the run row exists and the job is queued, so the run *will* execute. Rejecting
  // here would report a failure for work already under way, and leave the run unmarked either way.
  await runtime.events.emit(
    {
      events: [
        {
          type: "workflow.run.queued",
          payload: {
            workflowId: workflow.id,
            runId,
            queuedAt: queuedAt.toISOString(),
            ...(job?.id ? { jobId: job.id } : {}),
            ...(options.source ? { source: options.source } : {}),
          },
        },
      ],
    },
    { source: "Sixb" }
  )

  return {
    workflowId: workflow.id,
    runId,
    queuedAt: queuedAt.toISOString(),
    jobId: job?.id,
    created: true,
  }
}

function createWorkflowRunId(runId: string | undefined): string {
  if (runId !== undefined) {
    if (!runId.trim()) {
      throw new WorkflowValidationError("[Sixb] Workflow run id must not be empty")
    }
    return runId
  }

  return `run_${randomUUID()}`
}
