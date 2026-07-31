import { ActionWorker } from "@sixb/action-worker"
import { AgentWorker } from "@sixb/agent-worker"
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
  /**
   * Why this worker cannot be constructed with the given options, or `null` when it can.
   *
   * Lets a caller find out before constructing anything. `sixb worker-group` builds its
   * workers in one `map()`, so without this the first unconstructable type threw and the
   * rest were never even attempted — the operator learned about one problem at a time.
   */
  readonly unmetRequirement?: (options: WorkerCreationOptions) => string | null
}

const AGENT_ORIGIN_REQUIRED =
  "requires --api-public-origin or SIXB_API_PUBLIC_ORIGIN (agent workers call the API)"

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
    unmetRequirement: (options) =>
      agentApiBaseUrl(options.agentApiBaseUrl) ? null : AGENT_ORIGIN_REQUIRED,
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

export interface WorkerGroupInputs {
  readonly workerTypes: readonly string[]
  readonly options: WorkerCreationOptions
  /**
   * Whether the types came from `resolveRegisteredWorkerTypes` rather than from the
   * command line. It changes the remedy, not the outcome: a type the operator asked for
   * has to be fixed, while an auto-selected one can also be dropped by naming the rest.
   */
  readonly autoSelected: boolean
}

/**
 * Refuses a worker group that cannot start whole, naming every reason at once.
 *
 * Refusing is right, and stayed right: an operator who deploys a group and gets five of
 * six workers has agent jobs piling up in a queue nobody claims, which looks exactly
 * like an idle system. What was wrong was the report. `sixb worker-group` on a project
 * with agents and no `--api-public-origin` started nothing and said only "Agent workers
 * require --api-public-origin" — no mention that this is why sync, pipeline and the rest
 * never came up, and none that the operator had never asked for an agent worker in the
 * first place.
 */
export function assertWorkerInputs(input: WorkerGroupInputs): void {
  const unmet = input.workerTypes
    .map((workerType) => ({
      workerType,
      reason: workerFactories[workerType]?.unmetRequirement?.(input.options) ?? null,
    }))
    .filter((entry): entry is { workerType: string; reason: string } => entry.reason !== null)

  if (unmet.length === 0) return

  const blocked = unmet.map((entry) => `${entry.workerType} ${entry.reason}`).join("; ")
  const ready = input.workerTypes.filter(
    (workerType) => !unmet.some((entry) => entry.workerType === workerType)
  )
  const readyNote =
    ready.length > 0
      ? ` No worker started, including the ${ready.length} that were ready (${ready.join(", ")}).`
      : ""
  const remedy = input.autoSelected
    ? ` These were selected automatically from what the project registers. Fix the above, or ` +
      `name the workers you want: \`sixb worker-group ${ready.join(" ")}\`.`
    : ""

  throw new Error(`[SixbCLI] \`sixb worker-group\` cannot start: ${blocked}.${readyNote}${remedy}`)
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

function agentApiBaseUrl(value: string | undefined): string | null {
  return value?.trim() || process.env.SIXB_API_PUBLIC_ORIGIN?.trim() || null
}

function resolveAgentApiBaseUrl(value: string | undefined): string {
  const apiBaseUrl = agentApiBaseUrl(value)
  if (!apiBaseUrl) {
    throw new Error(`[SixbWorker] The agent worker ${AGENT_ORIGIN_REQUIRED}.`)
  }
  return apiBaseUrl
}
