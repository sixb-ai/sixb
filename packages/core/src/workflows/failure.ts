import { createSixbError, isSixbError, summarizeErrorMessage } from "../errors/internal"

interface WorkflowNodeFailureIdentityBase {
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
}

export interface WorkflowNodeFailureIdentity extends WorkflowNodeFailureIdentityBase {
  readonly child:
    | { readonly type: "step"; readonly stepId: string }
    | {
        readonly type: "action"
        readonly actionId: string
        readonly actionRunId?: string
      }
    | { readonly type: "agent"; readonly agentId: string }
    | { readonly type: "intervention"; readonly interventionId: string }
}

/** Translate a node-local failure into the workflow primitive's durable vocabulary. */
export function createWorkflowNodeFailure(error: unknown, identity: WorkflowNodeFailureIdentity) {
  return createSixbError(
    "workflow.node_failed",
    summarizeErrorMessage(error, "Workflow node execution failed."),
    {
      cause: error,
      details: workflowNodeFailureDetails(identity),
    }
  )
}

/** Recover the native child error for direct callers and error-monitoring integrations. */
export function unwrapWorkflowNodeFailure(error: unknown): unknown {
  return isSixbError(error) && error.code === "workflow.node_failed" && error.cause !== undefined
    ? error.cause
    : error
}

function workflowNodeFailureDetails(identity: WorkflowNodeFailureIdentity) {
  const base = {
    workflowId: identity.workflowId,
    workflowRunId: identity.workflowRunId,
    nodeId: identity.nodeId,
    ...(identity.nodeRunId ? { nodeRunId: identity.nodeRunId } : {}),
  }

  switch (identity.child.type) {
    case "step":
      return { ...base, stepId: identity.child.stepId }
    case "action":
      return {
        ...base,
        actionId: identity.child.actionId,
        ...(identity.child.actionRunId ? { actionRunId: identity.child.actionRunId } : {}),
      }
    case "agent":
      return { ...base, agentId: identity.child.agentId }
    case "intervention":
      return { ...base, interventionId: identity.child.interventionId }
  }
}
