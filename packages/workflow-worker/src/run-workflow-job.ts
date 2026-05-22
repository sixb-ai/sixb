import { workflowNodeExecutors } from "./execution/node-executors"
import { WorkflowRunSession } from "./execution/workflow-run-session"
import type { RunWorkflowJobInput, WorkflowRunResult } from "./types"

export async function runWorkflowJob(input: RunWorkflowJobInput): Promise<WorkflowRunResult> {
  const session = WorkflowRunSession.create(input, {
    executors: workflowNodeExecutors,
  })

  try {
    await session.start()
    await session.runAllNodes()
    return await session.finishSucceeded()
  } catch (error) {
    await session.finishAfterError(error)
    throw error
  }
}
