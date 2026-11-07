import { captureSixbFailure } from "@sixb/core/internal/errors"
import { unwrapWorkflowNodeFailure } from "@sixb/core/internal/workflows"
import { WORKFLOW_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { workflowNodeExecutors } from "./execution/node-executors"
import { WorkflowRunSession } from "./execution/workflow-run-session"
import { statusForFailure } from "./normalize"
import type { RunWorkflowJobInput, RunWorkflowResumeJobInput, WorkflowRunResult } from "./types"

/**
 * Run what is left of one workflow run this delivery holds. A run that resumes picks up from its
 * node records. A stopped worker writes nothing: the run stays running for the next delivery.
 */
export async function runWorkflowJob(input: RunWorkflowJobInput): Promise<WorkflowRunResult> {
  let session: WorkflowRunSession
  try {
    session =
      input.claim.outcome === "resumed"
        ? await WorkflowRunSession.recoverRunning(input, { executors: workflowNodeExecutors })
        : WorkflowRunSession.create(input, { executors: workflowNodeExecutors })
  } catch (error) {
    await failRunBeforeItsSession(input, error)
    throw error
  }

  try {
    if (input.claim.outcome === "started") await session.announceStarted(input.claim.run)

    const waitingRun = await session.runAllNodes()
    if (waitingRun) {
      return session.finishWaiting(waitingRun)
    }
    return await session.finishSucceeded()
  } catch (error) {
    if (input.signal?.aborted) {
      throw error
    }
    await session.finishAfterError(error)
    throw unwrapWorkflowNodeFailure(error)
  } finally {
    await session.flushLogs()
  }
}

export async function runWorkflowResumeJob(
  input: RunWorkflowResumeJobInput
): Promise<WorkflowRunResult> {
  const sessionOrResult = await WorkflowRunSession.createForResume(input, {
    executors: workflowNodeExecutors,
  })
  if (!(sessionOrResult instanceof WorkflowRunSession)) {
    return sessionOrResult
  }

  const session = sessionOrResult
  try {
    const waitingRun = await session.runAllNodes()
    if (waitingRun) {
      return session.finishWaiting(waitingRun)
    }
    return await session.finishSucceeded()
  } catch (error) {
    if (input.signal?.aborted) {
      throw error
    }
    await session.finishAfterError(error)
    throw unwrapWorkflowNodeFailure(error)
  } finally {
    await session.flushLogs()
  }
}

async function failRunBeforeItsSession(input: RunWorkflowJobInput, error: unknown): Promise<void> {
  const signal = input.signal ?? new AbortController().signal
  if (signal.aborted) return

  const status = statusForFailure(signal, error)
  const failure = captureSixbFailure(error, {
    allowedCodes: WORKFLOW_RUN_FAILURE_CODES,
    defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
    details: { workflowId: input.job.workflowId, runId: input.job.id },
  })
  const failed = await input.runtime.workflowRuns.finish({
    projectId: input.runtime.projectId,
    id: input.job.id,
    executionToken: input.job.execution.token,
    status,
    error: failure,
  })

  if (failed.status === "failed") {
    input.onRunFailed?.(error, failed, failure)
  }

  try {
    await input.observer?.onRunFinished(failed)
  } catch (observerError) {
    // Lost event batches are reported by the observer itself. Anything reaching here is a broken
    // invariant in a custom observer, not a delivery failure.
    console.error("[SixbWorkflowWorker] Workflow lifecycle observer failed:", observerError)
  }
}
