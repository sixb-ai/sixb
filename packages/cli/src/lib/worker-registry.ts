import { ActionWorker } from "@pario/action-worker"
import type { Worker } from "@pario/core"
import { PipelineWorker } from "@pario/pipeline-worker"
import { ProjectionWorker } from "@pario/projection-worker"
import { SyncWorker } from "@pario/sync-worker"
import { WorkflowWorker } from "@pario/workflow-worker"
import type { LoadedPario } from "./loadPario"

interface WorkerFactory {
  readonly create: (pario: LoadedPario) => Worker
  readonly hasRegisteredDefinitions: (pario: LoadedPario) => boolean
}

const workerFactories: Record<string, WorkerFactory> = {
  sync: {
    create: (pario) => new SyncWorker(pario),
    hasRegisteredDefinitions: (pario) => pario.getSyncDefinitions().length > 0,
  },
  action: {
    create: (pario) => new ActionWorker(pario),
    hasRegisteredDefinitions: (pario) => pario.getActionDefinitions().length > 0,
  },
  pipeline: {
    create: (pario) => new PipelineWorker(pario),
    hasRegisteredDefinitions: (pario) => pario.getPipelineDefinitions().length > 0,
  },
  projection: {
    create: (pario) => new ProjectionWorker(pario),
    hasRegisteredDefinitions: (pario) =>
      pario.getObjectProjections().length + pario.getLinkProjections().length > 0,
  },
  workflow: {
    create: (pario) => new WorkflowWorker(pario),
    hasRegisteredDefinitions: (pario) => pario.getWorkflowDefinitions().length > 0,
  },
}

export function createWorkerForType(pario: LoadedPario, workerType: string): Worker {
  const factory = workerFactories[workerType]
  if (!factory) {
    throw new Error(`[ParioWorker] Unknown worker '${workerType}'. Available: ${knownWorkers()}`)
  }

  return factory.create(pario)
}

export function resolveWorkerTypesToStart(
  pario: LoadedPario,
  requestedWorker?: string
): readonly string[] {
  if (requestedWorker) {
    if (!workerFactories[requestedWorker]) {
      throw new Error(
        `[ParioWorker] Unknown worker '${requestedWorker}'. Available: ${knownWorkers()}`
      )
    }
    return [requestedWorker]
  }

  const registeredWorkers = Object.entries(workerFactories)
    .filter(([, factory]) => factory.hasRegisteredDefinitions(pario))
    .map(([workerType]) => workerType)

  if (registeredWorkers.length === 0) {
    throw new Error(
      "[ParioWorker] No worker definitions are registered. Add a sync, action, pipeline, projection, or workflow, or pass --worker <type> to start a specific worker."
    )
  }

  return registeredWorkers
}

function knownWorkers(): string {
  return Object.keys(workerFactories).join(", ")
}
