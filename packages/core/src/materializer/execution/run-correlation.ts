import { SixbError } from "../../errors"
import { materializationConflict } from "../../materialization/errors"
import type { ProjectionMaterializationIdentity } from "../../materialization/model"
import type { ProjectionDefinition, ResolvedProjection } from "../../projections/types"
import type { ProjectionRunRecord, ProjectionRunStorage, Storage } from "../../storage"

export interface LockProjectionExecutionInput {
  readonly projectId: string
  readonly projectionRunId: string
  readonly executionToken: string
  readonly identity: ProjectionMaterializationIdentity
  readonly resolved: ResolvedProjection<ProjectionDefinition>
  readonly capabilityErrorMessage?: string
}

export interface LockedProjectionExecution {
  readonly projectionRuns: ProjectionRunStorage
  readonly run: ProjectionRunRecord
}

/** Locks and validates the current execution inside the materialization transaction. */
export async function lockProjectionRunForMaterialization(
  storage: Pick<Storage, "projectionRuns">,
  input: LockProjectionExecutionInput
): Promise<LockedProjectionExecution> {
  const projectionRuns = storage.projectionRuns
  if (!projectionRuns) {
    throw new SixbError(
      "ontology.invalid_value",
      `[Sixb] ${input.capabilityErrorMessage ?? "Storage transaction does not provide projection run capabilities."}`
    )
  }

  const run = await projectionRuns.lockForMaterialization({
    id: input.projectionRunId,
    projectId: input.projectId,
    executionToken: input.executionToken,
    identity: input.identity,
  })
  assertProjectionRunTargets(run, input.resolved)
  return { projectionRuns, run }
}

export function assertProjectionRunTargets(
  run: ProjectionRunRecord,
  resolved: ResolvedProjection<ProjectionDefinition>
): void {
  if (projectionRunTargetsMatch(run, resolved.definition)) return

  throw materializationConflict(
    "run-correlation",
    `Projection run '${run.id}' target object types do not match projection '${resolved.projectionId}'.`
  )
}

function projectionRunTargetsMatch(
  run: ProjectionRunRecord,
  definition: ProjectionDefinition
): boolean {
  switch (definition._tag) {
    case "ObjectProjectionDefinition":
    case "TelemetryProjectionDefinition":
      return "objectTypeId" in run.target && run.target.objectTypeId === definition.objectTypeId
    case "LinkProjectionDefinition":
      return (
        "sourceObjectTypeId" in run.target &&
        run.target.sourceObjectTypeId === definition.sourceObjectTypeId &&
        run.target.targetObjectTypeId === definition.targetObjectTypeId
      )
  }
}
