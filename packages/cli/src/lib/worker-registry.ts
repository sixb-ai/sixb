import { ActionWorker } from "@sixb/action-worker"
import { InMemoryQueues, type Worker } from "@sixb/core"
import { PipelineWorker } from "@sixb/pipeline-worker"
import { ProjectionWorker } from "@sixb/projection-worker"
import { SyncWorker } from "@sixb/sync-worker"
import { WorkflowWorker } from "@sixb/workflow-worker"
import type { LoadedSixb } from "./loadSixb"

interface WorkerFactory {
  readonly create: (sixb: LoadedSixb) => Worker
}

const workerFactories: Record<string, WorkerFactory> = {
  sync: {
    create: (sixb) => new SyncWorker(sixb),
  },
  action: {
    create: (sixb) => new ActionWorker(sixb),
  },
  pipeline: {
    create: (sixb) => new PipelineWorker(sixb),
  },
  projection: {
    create: (sixb) => new ProjectionWorker(sixb),
  },
  workflow: {
    create: (sixb) => new WorkflowWorker(sixb),
  },
}

export function createWorkerForType(sixb: LoadedSixb, workerType: string): Worker {
  const factory = workerFactories[workerType]
  if (!factory) {
    throw new Error(`[SixbWorker] Unknown worker '${workerType}'. Available: ${knownWorkers()}`)
  }

  return factory.create(sixb)
}

export function resolveWorkerTypeToStart(requestedWorker?: string): string {
  if (!requestedWorker) {
    throw new Error(`[SixbWorker] Usage: sixb worker <${knownWorkers().replaceAll(", ", "|")}>`)
  }

  if (!workerFactories[requestedWorker]) {
    throw new Error(
      `[SixbWorker] Unknown worker '${requestedWorker}'. Available: ${knownWorkers()}`
    )
  }

  return requestedWorker
}

export function resolveRegisteredWorkerTypes(sixb: LoadedSixb): readonly string[] {
  const workerTypes: string[] = []

  if (sixb.getSyncDefinitions().length > 0) {
    workerTypes.push("sync")
  }

  if (sixb.getPipelineDefinitions().length > 0) {
    workerTypes.push("pipeline")
  }

  if (sixb.getObjectProjections().length + sixb.getLinkProjections().length > 0) {
    workerTypes.push("projection")
  }

  if (sixb.getActionDefinitions().length > 0) {
    workerTypes.push("action")
  }

  if (sixb.workflows.list().length > 0) {
    workerTypes.push("workflow")
  }

  return workerTypes
}

function knownWorkers(): string {
  return Object.keys(workerFactories).join(", ")
}

export function usesInMemoryQueues(sixb: LoadedSixb): boolean {
  const queues = sixb.queues as { provider?: unknown }
  return sixb.queues instanceof InMemoryQueues || queues.provider === "in-memory"
}
