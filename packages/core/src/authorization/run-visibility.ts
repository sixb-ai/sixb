import type { ProjectionDefinition, ProjectionTarget } from "../projections"
import { projectionTargetOf } from "../projections/builders"
import type { ActionRunRecord } from "../storage/action-runs"
import type { PipelineRunRecord } from "../storage/pipeline-runs"
import type { WorkflowInterventionRecord } from "../storage/workflow-interventions"
import type { WorkflowRunRecord } from "../storage/workflow-runs"
import { isAllowed } from "./decision"
import type { AuthorizationContext } from "./types"

/**
 * Whether a principal may view a run, by its action and its subject's type. A type the principal
 * views only through a condition fails here: the subject decides, which `viewableActionRuns` reads.
 */
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

/**
 * A projection run is viewable when its target object type(s) are viewable. A run, like its
 * definition, describes every object of the type, so a type viewed through a condition stays closed.
 */
export function canViewProjectionRun(
  authorization: AuthorizationContext | null | undefined,
  target: ProjectionTarget
): boolean {
  if (!authorization) return true
  const canView = (objectTypeId: string) =>
    isAllowed(authorization, { kind: "object.view", objectTypeId })
  if ("sourceObjectTypeId" in target) {
    return canView(target.sourceObjectTypeId) && canView(target.targetObjectTypeId)
  }
  return canView(target.objectTypeId)
}

/**
 * A trusted primitive's run as its visibility is decided: by the primitive's definition, or, for a
 * projection, by the object types it targets. An Action run is decided by its subject too, which
 * `viewableActionRuns` reads.
 */
export type PrimitiveRunSubject =
  | {
      readonly kind: "pipeline" | "sync" | "workflow" | "rule" | "webhook"
      readonly id: string
    }
  | { readonly kind: "projection"; readonly target: ProjectionTarget }

/**
 * Whether a principal may view a trusted primitive's run, decided as that primitive's run facade
 * decides. Rules and webhooks have no run facade, so a principal sees none of their runs.
 */
export function canViewPrimitiveRun(
  authorization: AuthorizationContext | null | undefined,
  run: PrimitiveRunSubject
): boolean {
  if (!authorization) return true

  switch (run.kind) {
    case "pipeline":
      return canViewPipelineRun(authorization, { pipelineId: run.id })
    case "sync":
      return isAllowed(authorization, { kind: "sync.run", syncId: run.id })
    case "workflow":
      return canViewWorkflowRun(authorization, { workflowId: run.id })
    case "projection":
      return canViewProjectionRun(authorization, run.target)
    case "rule":
    case "webhook":
      return false
  }
}

/** Whether a principal may see a projection definition (and its run history). */
export function canViewProjection(
  authorization: AuthorizationContext | null | undefined,
  projection: ProjectionDefinition
): boolean {
  return canViewProjectionRun(authorization, projectionTargetOf(projection))
}
