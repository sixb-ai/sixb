import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type { ProjectionDefinition, ResolvedProjection } from "../../projections/types"
import {
  isProjectionMaterializationRunStorage,
  type ProjectionMaterializationRunRecord,
  type ProjectionMaterializationRunStorage,
  type ProjectionRunMaterializationIdentity,
  type Storage,
} from "../../storage"

export interface AssertProjectionExecutionInput {
  readonly projectId: string
  readonly projectionRunId: string
  readonly executionToken: string
  readonly identity: ProjectionRunMaterializationIdentity
  readonly resolved: ResolvedProjection<ProjectionDefinition>
  readonly capabilityErrorMessage?: string
}

export interface AssertedProjectionExecution {
  readonly projectionRuns: ProjectionMaterializationRunStorage
  readonly run: ProjectionMaterializationRunRecord
}

export async function assertProjectionMaterializationExecution(
  storage: Pick<Storage, "projectionRuns">,
  input: AssertProjectionExecutionInput
): Promise<AssertedProjectionExecution> {
  if (!isProjectionMaterializationRunStorage(storage.projectionRuns)) {
    throw new MaterializationValidationError(
      input.capabilityErrorMessage ??
        "Storage transaction does not provide projection run capabilities."
    )
  }

  const projectionRuns = storage.projectionRuns
  const run = await projectionRuns.assertMaterializationExecution({
    id: input.projectionRunId,
    projectId: input.projectId,
    executionToken: input.executionToken,
    identity: input.identity,
  })
  assertProjectionRunTargets(run, input.resolved)
  return { projectionRuns, run }
}

export function assertProjectionRunTargets(
  run: ProjectionMaterializationRunRecord,
  resolved: ResolvedProjection<ProjectionDefinition>
): void {
  if (projectionRunTargetsMatch(run, resolved.definition)) return

  throw new MaterializationConflictError(
    "run-correlation",
    `Projection run '${run.id}' target object types do not match projection '${resolved.projectionId}'.`
  )
}

function projectionRunTargetsMatch(
  run: ProjectionMaterializationRunRecord,
  definition: ProjectionDefinition
): boolean {
  switch (definition._tag) {
    case "ObjectProjectionDefinition":
    case "TelemetryProjectionDefinition":
      return matchesSingleObjectTarget(run, definition.objectTypeId)
    case "LinkProjectionDefinition":
      return matchesLinkTargets(run, definition.sourceObjectTypeId, definition.targetObjectTypeId)
  }
}

function matchesSingleObjectTarget(
  run: ProjectionMaterializationRunRecord,
  objectTypeId: string
): boolean {
  return (
    run.objectTypeId === objectTypeId &&
    run.sourceObjectTypeId === undefined &&
    run.targetObjectTypeId === undefined
  )
}

function matchesLinkTargets(
  run: ProjectionMaterializationRunRecord,
  sourceObjectTypeId: string,
  targetObjectTypeId: string
): boolean {
  return (
    run.objectTypeId === undefined &&
    run.sourceObjectTypeId === sourceObjectTypeId &&
    run.targetObjectTypeId === targetObjectTypeId
  )
}
