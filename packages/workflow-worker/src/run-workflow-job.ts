import { workflowNodeExecutors } from "./execution/node-executors"
import { WorkflowRunSession } from "./execution/workflow-run-session"
import { statusForFailure, toWorkflowRunError } from "./normalize"
import type { RunWorkflowJobInput, RunWorkflowResumeJobInput, WorkflowRunResult } from "./types"

export async function runWorkflowJob(input: RunWorkflowJobInput): Promise<WorkflowRunResult> {
  let session: WorkflowRunSession
  try {
    session = WorkflowRunSession.create(input, {
      executors: workflowNodeExecutors,
    })
  } catch (error) {
    await failQueuedRun(input, error)
    throw error
  }

  try {
    await session.start()
    const waitingRun = await session.runAllNodes()
    if (waitingRun) {
      return session.finishWaiting(waitingRun)
    }
    return await session.finishSucceeded()
  } catch (error) {
    await session.finishAfterError(error)
    await failQueuedRun(input, error)
    throw error
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
    await session.finishAfterError(error)
    throw error
  }
}

async function failQueuedRun(input: RunWorkflowJobInput, error: unknown): Promise<void> {
  const run = await input.runtime.workflowRuns.getById({
    projectId: input.runtime.projectId,
    id: input.job.id,
  })
  if (run?.status !== "queued") {
    return
  }

  const failed = await input.runtime.workflowRuns.finish({
    projectId: input.runtime.projectId,
    id: input.job.id,
    status: statusForFailure(input.signal ?? new AbortController().signal, error),
    error: toWorkflowRunError(error),
  })

  try {
    await input.observer?.onRunFinished(failed)
  } catch (observerError) {
    console.error("[ParioWorkflowWorker] Failed to emit workflow lifecycle event:", observerError)
  }
}
