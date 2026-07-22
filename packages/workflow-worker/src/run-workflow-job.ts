import { workflowNodeExecutors } from "./execution/node-executors"
import { WorkflowRunSession } from "./execution/workflow-run-session"
import { statusForFailure, toWorkflowRunError } from "./normalize"
import type { RunWorkflowJobInput, RunWorkflowResumeJobInput, WorkflowRunResult } from "./types"

export async function runWorkflowJob(input: RunWorkflowJobInput): Promise<WorkflowRunResult> {
  const existing = await completedWorkflowRunResult(input)
  if (existing) {
    return existing
  }

  let session: WorkflowRunSession
  try {
    const active = await input.runtime.workflowRuns.getById({
      projectId: input.runtime.projectId,
      id: input.job.id,
    })
    session =
      active?.status === "running"
        ? await WorkflowRunSession.recoverRunning(input, {
            executors: workflowNodeExecutors,
          })
        : WorkflowRunSession.create(input, {
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
    if (input.job.execution && input.signal?.aborted) {
      throw error
    }
    await session.finishAfterError(error)
    await failQueuedRun(input, error)
    throw error
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
    if (input.job.execution && input.signal?.aborted) {
      throw error
    }
    await session.finishAfterError(error)
    throw error
  } finally {
    await session.flushLogs()
  }
}

async function completedWorkflowRunResult(
  input: RunWorkflowJobInput
): Promise<WorkflowRunResult | null> {
  const run = await input.runtime.workflowRuns.getById({
    projectId: input.runtime.projectId,
    id: input.job.id,
  })
  if (!run || run.status === "queued" || run.status === "running") {
    return null
  }

  if (run.workflowId !== input.job.workflowId) {
    throw new Error(
      `[SixbWorkflowWorker] Workflow run '${input.job.id}' belongs to workflow '${run.workflowId}', not '${input.job.workflowId}'.`
    )
  }

  const nodes = await input.runtime.workflowRuns.nodes.list({
    projectId: input.runtime.projectId,
    workflowRunId: run.id,
    order: "asc",
  })

  return {
    id: input.job.id,
    workflowId: input.job.workflowId,
    status: run.status,
    run,
    nodes: nodes.nodes,
    steps: {},
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

  if (failed.status === "failed") {
    input.onRunFailed?.(error, failed)
  }

  try {
    await input.observer?.onRunFinished(failed)
  } catch (observerError) {
    console.error("[SixbWorkflowWorker] Failed to emit workflow lifecycle event:", observerError)
  }
}
