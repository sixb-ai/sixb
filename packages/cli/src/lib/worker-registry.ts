import { ActionWorker } from "@sixb/action-worker"
import { AgentWorker } from "@sixb/agent-worker"
import { InMemoryQueues } from "@sixb/core"
import type { Worker } from "@sixb/core/internal/workers"
import { PipelineWorker } from "@sixb/pipeline-worker"
import { ProjectionWorker } from "@sixb/projection-worker"
import { SyncWorker } from "@sixb/sync-worker"
import { WorkflowWorker } from "@sixb/workflow-worker"
import type { LoadedSixb } from "./loadSixb"

export interface WorkerCreationOptions {
  readonly agentApiBaseUrl?: string
}

interface WorkerFactory {
  readonly create: (sixb: LoadedSixb, options: WorkerCreationOptions) => Worker
}

const workerFactories: Record<string, WorkerFactory> = {
  sync: {
    create: (sixb) => new SyncWorker(sixb),
  },
  action: {
    create: (sixb) => new ActionWorker(sixb),
  },
  agent: {
    create: (sixb, options) =>
      new AgentWorker(sixb, {
        apiBaseUrl: resolveAgentApiBaseUrl(options.agentApiBaseUrl),
      }),
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

export function createWorkerForType(
  sixb: LoadedSixb,
  workerType: string,
  options: WorkerCreationOptions = {}
): Worker {
  const factory = workerFactories[workerType]
  if (!factory) {
    throw new Error(`[SixbWorker] Unknown worker '${workerType}'. Available: ${knownWorkers()}`)
  }

  return factory.create(sixb, options)
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

  if (sixb.listSyncs().length > 0) {
    workerTypes.push("sync")
  }

  if (sixb.listPipelines().length > 0) {
    workerTypes.push("pipeline")
  }

  if (
    sixb.listObjectProjections().length +
      sixb.listLinkProjections().length +
      sixb.listTelemetryProjections().length >
    0
  ) {
    workerTypes.push("projection")
  }

  if (sixb.listActions().length > 0) {
    workerTypes.push("action")
  }

  if (sixb.agents.list().length > 0 && sixb.storage.agents) {
    workerTypes.push("agent")
  }

  if (sixb.workflows.list().length > 0) {
    workerTypes.push("workflow")
  }

  return workerTypes
}

function knownWorkers(): string {
  return Object.keys(workerFactories).join(", ")
}

function resolveAgentApiBaseUrl(value: string | undefined): string {
  const apiBaseUrl = value?.trim() || process.env.SIXB_API_PUBLIC_ORIGIN?.trim()
  if (!apiBaseUrl) {
    throw new Error(
      "[SixbWorker] Agent workers require --api-public-origin or SIXB_API_PUBLIC_ORIGIN."
    )
  }
  return apiBaseUrl
}

export function usesInMemoryQueues(sixb: LoadedSixb): boolean {
  const queues = sixb.queues as { provider?: unknown }
  return sixb.queues instanceof InMemoryQueues || queues.provider === "in-memory"
}
