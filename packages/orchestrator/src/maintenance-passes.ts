import { createSixbError } from "@sixb/core/internal/errors"
import { everyMs, type MaintenancePass } from "@sixb/core/internal/maintenance"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import type { LakeStorage } from "@sixb/core/lake-storage"
import { DatasetTriggerReconciler, datasetTriggers } from "./dataset-trigger-reconciler"
import { LakeChangeFeed } from "./lake-change-feed"
import { ProjectionDispatchReconciler } from "./projection-dispatch-reconciler"
import type {
  DatasetTriggerReconciliationPorts,
  OrchestratorDispatchers,
  OrchestratorRoutes,
  ProjectionReconciliationPorts,
} from "./types"
import { requireDispatcher } from "./worker"

const INTERVAL_MS = 30_000

// A first pass looks every dataset up, and later ones read what changed: only a hung call gets here.
const PASS_BUDGET_MS = 5 * 60_000

export interface ReconciliationPassesInput {
  readonly projectId: string
  readonly routes: OrchestratorRoutes
  readonly dispatchers: OrchestratorDispatchers
  readonly lakeStorage: Pick<LakeStorage, "listLatestVersionsSince"> &
    ProjectionReconciliationPorts["lakeStorage"] &
    DatasetTriggerReconciliationPorts["lakeStorage"]
  /** Required when the routes contain projections. */
  readonly projectionRuns?: ProjectionReconciliationPorts["projectionRuns"]
  /** Without it, a pipeline's dataset triggers have only their event. */
  readonly pipelineRuns?: DatasetTriggerReconciliationPorts["pipelineRuns"]
}

/**
 * The passes that repair what the event path can lose, for the orchestrator's maintenance loop. A
 * route with nothing to repair adds no pass, so an idle project pays for none.
 */
export function createReconciliationPasses(
  input: ReconciliationPassesInput
): readonly MaintenancePass[] {
  const feed = new LakeChangeFeed({
    lakeStorage: input.lakeStorage,
    projectId: input.projectId,
    freshForMs: INTERVAL_MS,
  })

  return [projectionPass(input, feed), datasetTriggerPass(input, feed)].filter(
    (pass) => pass !== null
  )
}

function projectionPass(
  input: ReconciliationPassesInput,
  feed: LakeChangeFeed
): MaintenancePass | null {
  const descriptors = projectionDescriptors(input.projectId, input.routes)
  if (descriptors.length === 0) return null

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

  const reconciler = new ProjectionDispatchReconciler({
    lakeStorage: input.lakeStorage,
    projectionRuns: input.projectionRuns,
    projectId: input.projectId,
    dispatcher: requireDispatcher(input, "projections"),
    descriptors,
    feed,
    intervalMs: INTERVAL_MS,
  })

  return everyMs({
    id: "projections",
    intervalMs: INTERVAL_MS,
    budgetMs: PASS_BUDGET_MS,
    run: (signal) => reconciler.pass(signal),
  })
}

function datasetTriggerPass(
  input: ReconciliationPassesInput,
  feed: LakeChangeFeed
): MaintenancePass | null {
  const triggers = datasetTriggers(input.routes)
  if (triggers.length === 0 || !input.pipelineRuns) return null

  const reconciler = new DatasetTriggerReconciler({
    lakeStorage: input.lakeStorage,
    pipelineRuns: input.pipelineRuns,
    projectId: input.projectId,
    dispatcher: requireDispatcher(input, "pipelines"),
    triggers,
    feed,
    intervalMs: INTERVAL_MS,
  })

  return everyMs({
    id: "triggers",
    intervalMs: INTERVAL_MS,
    budgetMs: PASS_BUDGET_MS,
    run: (signal) => reconciler.pass(signal),
  })
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
