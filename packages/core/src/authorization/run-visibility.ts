import type { ActionRunRecord } from "../storage/action-runs"
import type { WorkflowInterventionRecord } from "../storage/workflow-interventions"
import type { WorkflowRunRecord } from "../storage/workflow-runs"
import { isAllowed } from "./decision"
import type { AuthorizationContext } from "./types"

export function canViewActionRun(
  authorization: AuthorizationContext | null | undefined,
  run: Pick<ActionRunRecord, "actionId" | "subject">
): boolean {
  if (!authorization) {
    return true
  }

  if (!isAllowed(authorization, { kind: "action.apply", actionId: run.actionId })) {
    return false
  }

  return run.subject.kind !== "object"
    ? true
    : isAllowed(authorization, {
        kind: "object.view",
        objectTypeId: run.subject.objectTypeId,
      })
}

export function canViewWorkflowRun(
  authorization: AuthorizationContext | null | undefined,
  run: Pick<WorkflowRunRecord, "workflowId">
): boolean {
  return (
    !authorization || isAllowed(authorization, { kind: "workflow.run", workflowId: run.workflowId })
  )
}

export function canViewWorkflowIntervention(
  authorization: AuthorizationContext | null | undefined,
  intervention: Pick<WorkflowInterventionRecord, "workflowId">
): boolean {
  return (
    !authorization ||
    isAllowed(authorization, { kind: "workflow.run", workflowId: intervention.workflowId })
  )
}
