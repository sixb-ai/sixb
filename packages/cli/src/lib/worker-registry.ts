import { ActionWorker } from "@pario/action-worker"
import { InMemoryQueues, type Worker } from "@pario/core"
import { PipelineWorker } from "@pario/pipeline-worker"
import { ProjectionWorker } from "@pario/projection-worker"
import { SyncWorker } from "@pario/sync-worker"
import { WorkflowWorker } from "@pario/workflow-worker"
import type { LoadedPario } from "./loadPario"

interface WorkerFactory {
  readonly create: (pario: LoadedPario) => Worker
}

const workerFactories: Record<string, WorkerFactory> = {
  sync: {
    create: (pario) => new SyncWorker(pario),
  },
  action: {
    create: (pario) => new ActionWorker(pario),
  },
  pipeline: {
    create: (pario) => new PipelineWorker(pario),
  },
  projection: {
    create: (pario) => new ProjectionWorker(pario),
  },
  workflow: {
    create: (pario) => new WorkflowWorker(pario),
  },
}

export function createWorkerForType(pario: LoadedPario, workerType: string): Worker {
  const factory = workerFactories[workerType]
  if (!factory) {
    throw new Error(`[ParioWorker] Unknown worker '${workerType}'. Available: ${knownWorkers()}`)
  }

  return factory.create(pario)
}

export function resolveWorkerTypeToStart(requestedWorker?: string): string {
  if (!requestedWorker) {
    throw new Error(`[ParioWorker] Usage: pario worker <${knownWorkers().replaceAll(", ", "|")}>`)
  }

  if (!workerFactories[requestedWorker]) {
    throw new Error(
      `[ParioWorker] Unknown worker '${requestedWorker}'. Available: ${knownWorkers()}`
    )
  }

  return requestedWorker
}

export function resolveRegisteredWorkerTypes(pario: LoadedPario): readonly string[] {
  const workerTypes: string[] = []

  if (pario.getSyncDefinitions().length > 0) {
    workerTypes.push("sync")
  }

  if (pario.getPipelineDefinitions().length > 0) {
    workerTypes.push("pipeline")
  }

  if (pario.getObjectProjections().length + pario.getLinkProjections().length > 0) {
    workerTypes.push("projection")
  }

  if (pario.getActionDefinitions().length > 0) {
    workerTypes.push("action")
  }

  if (pario.getWorkflowDefinitions().length > 0) {
    workerTypes.push("workflow")
  }

  return workerTypes
}

function knownWorkers(): string {
  return Object.keys(workerFactories).join(", ")
}

export function usesInMemoryQueues(pario: LoadedPario): boolean {
  const queues = pario.queues as { provider?: unknown }
  return pario.queues instanceof InMemoryQueues || queues.provider === "in-memory"
}
