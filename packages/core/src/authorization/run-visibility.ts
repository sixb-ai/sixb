import {
  type ProjectionDefinition,
  type ProjectionObjectTypeIds,
  projectionObjectTypeIds,
} from "../projections"
import type { ActionRunRecord } from "../storage/action-runs"
import type { PipelineRunRecord } from "../storage/pipeline-runs"
import { projectionTargetObjectTypesVisible } from "../storage/projection-runs"
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

export function canViewPipelineRun(
  authorization: AuthorizationContext | null | undefined,
  run: Pick<PipelineRunRecord, "pipelineId">
): boolean {
  return (
    !authorization || isAllowed(authorization, { kind: "pipeline.run", pipelineId: run.pipelineId })
  )
}

/** A projection run is viewable when its target object type(s) are viewable. */
export function canViewProjectionRun(
  authorization: AuthorizationContext | null | undefined,
  target: ProjectionObjectTypeIds
): boolean {
  return (
    !authorization ||
    projectionTargetObjectTypesVisible(target, (objectTypeId) =>
      isAllowed(authorization, { kind: "object.view", objectTypeId })
    )
  )
}

/** Whether a principal may see a projection definition (and its run history). */
export function canViewProjection(
  authorization: AuthorizationContext | null | undefined,
  projection: ProjectionDefinition
): boolean {
  return canViewProjectionRun(authorization, projectionObjectTypeIds(projection))
}
