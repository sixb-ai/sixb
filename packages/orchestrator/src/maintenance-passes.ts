import { createSixbError } from "@sixb/core/internal/errors"
import {
  type DatasetTrigger,
  type MaintenancePass,
  type RecoveryPassesInput,
  recoveryPasses,
} from "@sixb/core/internal/maintenance"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import type { OrchestratorDispatchers, OrchestratorRoutes } from "./types"
import { requireDispatcher } from "./worker"

export interface MaintenancePassesInput {
  readonly projectId: string
  readonly routes: OrchestratorRoutes
  readonly dispatchers: OrchestratorDispatchers
  readonly lakeStorage: RecoveryPassesInput["lakeStorage"]
  /** Required when the routes contain projections. */
  readonly projectionRuns?: NonNullable<RecoveryPassesInput["projections"]>["projectionRuns"]
  /** Without it, a pipeline's dataset triggers have only their event. */
  readonly pipelineRuns?: NonNullable<RecoveryPassesInput["triggers"]>["pipelineRuns"]
  /** When the project can ingest. */
  readonly ingest?: RecoveryPassesInput["ingest"]
}

/** The passes the routes call for, for the orchestrator's maintenance loop. */
export function createMaintenancePasses(input: MaintenancePassesInput): readonly MaintenancePass[] {
  const { projectId, lakeStorage } = input

  return recoveryPasses({
    projectId,
    lakeStorage,
    projections: projectionsOf(input),
    triggers: triggersOf(input),
    ingest: input.ingest,
  })
}

function projectionsOf(input: MaintenancePassesInput): RecoveryPassesInput["projections"] {
  const descriptors = projectionDescriptors(input.projectId, input.routes)
  if (descriptors.length === 0) return undefined

  if (!input.projectionRuns) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbOrchestrator] Projection routes require lake storage for durable reconciliation.",
      {
        details: {
          projectId: input.projectId,
          projectionIds: descriptors.map((descriptor) => descriptor.projectionId),
        },
      }
    )
  }

  return {
    descriptors,
    projectionRuns: input.projectionRuns,
    dispatcher: requireDispatcher(input, "projections"),
  }
}

function triggersOf(input: MaintenancePassesInput): RecoveryPassesInput["triggers"] {
  const triggers = datasetTriggers(input.routes)
  if (triggers.length === 0 || !input.pipelineRuns) return undefined

  return {
    triggers,
    pipelineRuns: input.pipelineRuns,
    dispatcher: requireDispatcher(input, "pipelines"),
  }
}

/** Every pipeline's `events.dataset(x).updated()` trigger, once per pipeline and dataset. */
export function datasetTriggers(routes: OrchestratorRoutes): readonly DatasetTrigger[] {
  const triggers = new Map<string, DatasetTrigger>()

  for (const route of routes.values()) {
    if (route.eventType !== "dataset.version.committed") continue

    for (const { schedule, targets } of route.eventSchedules ?? []) {
      const datasetId = schedule.trigger.source.datasetId
      if (datasetId === undefined) continue

      for (const target of targets) {
        if (target.queue !== "pipelines") continue

        const trigger = { pipelineId: target.pipelineId, scheduleId: schedule.id, datasetId }
        triggers.set(`${trigger.pipelineId}\u0000${trigger.datasetId}`, trigger)
      }
    }
  }

  return [...triggers.values()]
}

function projectionDescriptors(
  projectId: string,
  routes: OrchestratorRoutes
): readonly ProjectionDispatchDescriptor[] {
  const descriptors = new Map<string, ProjectionDispatchDescriptor>()

  for (const route of routes.values()) {
    for (const item of route.jobs) {
      if (item.queue !== "projections") continue

      const existing = descriptors.get(item.job.payload.projectionId)
      if (existing && !projectionDescriptorsEqual(existing, item.job.payload)) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbOrchestrator] Projection '${item.job.payload.projectionId}' has conflicting dispatch routes.`,
          { details: { projectId, projectionId: item.job.payload.projectionId } }
        )
      }

      descriptors.set(item.job.payload.projectionId, item.job.payload)
    }
  }

  return [...descriptors.values()].sort((left, right) =>
    left.projectionId.localeCompare(right.projectionId)
  )
}

function projectionDescriptorsEqual(
  left: ProjectionDispatchDescriptor,
  right: ProjectionDispatchDescriptor
): boolean {
  return (
    left.projectionId === right.projectionId &&
    left.projectionKind === right.projectionKind &&
    left.protocol === right.protocol &&
    left.datasetId === right.datasetId &&
    left.ontologyRevision === right.ontologyRevision &&
    left.projectionRevision === right.projectionRevision &&
    left.ownershipHash === right.ownershipHash
  )
}
