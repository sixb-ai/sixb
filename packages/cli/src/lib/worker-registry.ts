import { ActionWorker } from "@sixb/action-worker"
import { AgentWorker } from "@sixb/agent-worker"
import type { Worker } from "@sixb/core/internal/workers"
import { PipelineWorker } from "@sixb/pipeline-worker"
import { ProjectionWorker } from "@sixb/projection-worker"
import { SyncWorker } from "@sixb/sync-worker"
import { WorkflowWorker } from "@sixb/workflow-worker"
import { SixbCliError } from "./errors"
import type { LoadedSixbHost } from "./loadSixb"
import { configuredOrigin } from "./public-origin"

export const WORKER_TYPES = [
  "sync",
  "action",
  "agent",
  "pipeline",
  "projection",
  "workflow",
] as const

export type WorkerType = (typeof WORKER_TYPES)[number]

export const WORKER_CONCURRENCY_CONFIG = {
  sync: { configurable: true, environmentVariable: "SIXB_SYNC_WORKER_CONCURRENCY" },
  action: { configurable: false, environmentVariable: "SIXB_ACTION_WORKER_CONCURRENCY" },
  agent: { configurable: true, environmentVariable: "SIXB_AGENT_WORKER_CONCURRENCY" },
  pipeline: { configurable: true, environmentVariable: "SIXB_PIPELINE_WORKER_CONCURRENCY" },
  projection: { configurable: true, environmentVariable: "SIXB_PROJECTION_WORKER_CONCURRENCY" },
  workflow: { configurable: true, environmentVariable: "SIXB_WORKFLOW_WORKER_CONCURRENCY" },
} as const satisfies Record<
  WorkerType,
  { readonly configurable: boolean; readonly environmentVariable: string }
>

export type ConfigurableWorkerType = {
  [Type in WorkerType]: (typeof WORKER_CONCURRENCY_CONFIG)[Type]["configurable"] extends true
    ? Type
    : never
}[WorkerType]

export type WorkerConcurrency = Readonly<Partial<Record<ConfigurableWorkerType, number>>>
export type QueueWorkerProcess = Worker & { readonly concurrency: number }

export interface WorkerCreationOptions {
  readonly agentApiBaseUrl?: string
  readonly agentTurnTimeoutMs?: number
  readonly workerConcurrency?: WorkerConcurrency
}

interface WorkerFactory {
  readonly create: (sixb: LoadedSixbHost, options: WorkerCreationOptions) => QueueWorkerProcess
  /**
   * Why this worker cannot be constructed with the given options, or `null` when it can.
   * Asked before anything is constructed, so a group names every reason at once.
   *
   * A malformed input throws instead of answering: it is one bad value rather than one
   * unsatisfied worker, and the list of workers it took down would say nothing about it.
   */
  readonly unmetRequirement?: (options: WorkerCreationOptions) => string | null
}

const AGENT_ORIGIN_REQUIRED =
  "requires --api-public-origin or SIXB_API_PUBLIC_ORIGIN (agent workers call the API)"

const workerFactories: Record<WorkerType, WorkerFactory> = {
  sync: {
    create: (sixb, options) =>
      new SyncWorker(sixb, { concurrency: options.workerConcurrency?.sync }),
  },
  action: {
    create: (sixb) => new ActionWorker(sixb),
  },
  agent: {
    create: (sixb, options) =>
      new AgentWorker(sixb, {
        apiBaseUrl: resolveAgentApiBaseUrl(options.agentApiBaseUrl),
        concurrency: options.workerConcurrency?.agent,
        turnTimeoutMs: options.agentTurnTimeoutMs,
      }),
    unmetRequirement: (options) =>
      agentApiBaseUrl(options.agentApiBaseUrl) ? null : AGENT_ORIGIN_REQUIRED,
  },
  pipeline: {
    create: (sixb, options) =>
      new PipelineWorker(sixb, { concurrency: options.workerConcurrency?.pipeline }),
  },
  projection: {
    create: (sixb, options) =>
      new ProjectionWorker(sixb, { concurrency: options.workerConcurrency?.projection }),
  },
  workflow: {
    create: (sixb, options) =>
      new WorkflowWorker(sixb, { concurrency: options.workerConcurrency?.workflow }),
  },
}

export function createWorkerForType(
  sixb: LoadedSixbHost,
  workerType: string,
  options: WorkerCreationOptions = {}
): QueueWorkerProcess {
  const factory = isWorkerType(workerType) ? workerFactories[workerType] : undefined
  if (!factory) {
    throw new Error(`[SixbWorker] Unknown worker '${workerType}'. Available: ${knownWorkers()}`)
  }

  return factory.create(sixb, options)
}

export function resolveWorkerTypeToStart(requestedWorker?: string): WorkerType {
  if (!requestedWorker) {
    throw new Error(`[SixbWorker] Usage: sixb worker <${knownWorkers().replaceAll(", ", "|")}>`)
  }

  if (!isWorkerType(requestedWorker)) {
    throw new Error(
      `[SixbWorker] Unknown worker '${requestedWorker}'. Available: ${knownWorkers()}`
    )
  }

  return requestedWorker
}

/**
 * Why this worker cannot be constructed with these options, or `null` when it can. Exported
 * for `sixb worker`, which has to answer this before it migrates storage.
 */
export function unmetWorkerRequirement(
  workerType: string,
  options: WorkerCreationOptions
): string | null {
  return isWorkerType(workerType)
    ? (workerFactories[workerType].unmetRequirement?.(options) ?? null)
    : null
}

export interface WorkerGroupInputs {
  readonly workerTypes: readonly string[]
  readonly options: WorkerCreationOptions
  /**
   * Whether the types were auto-selected rather than named on the command line. It changes the
   * remedy only: an auto-selected type can also be dropped by naming the rest.
   */
  readonly autoSelected: boolean
}

/**
 * Refuses a worker group that cannot start whole, naming every reason at once.
 *
 * Five of six workers means jobs piling up in a queue nobody claims, which looks exactly like
 * an idle system — so the refusal is right, and it has to say which workers it took down.
 */
export function assertWorkerInputs(input: WorkerGroupInputs): void {
  const unmet = input.workerTypes
    .map((workerType) => ({
      workerType,
      reason: unmetWorkerRequirement(workerType, input.options),
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
  // Only when there is something to name: with every auto-selected worker blocked, this
  // offered the command that had just failed as the way out of its own failure.
  const remediation =
    input.autoSelected && ready.length > 0
      ? `These were selected automatically from what the project registers. Fix the above, or ` +
        `name the workers you want: \`sixb worker-group ${ready.join(" ")}\`.`
      : undefined

  throw new SixbCliError(`[SixbCLI] \`sixb worker-group\` cannot start: ${blocked}.${readyNote}`, {
    remediation,
  })
}

export function resolveRegisteredWorkerTypes(sixb: LoadedSixbHost): readonly WorkerType[] {
  const workerTypes: WorkerType[] = []

  if (sixb.definitions.syncs.list().length > 0) {
    workerTypes.push("sync")
  }

  if (sixb.definitions.pipelines.list().length > 0) {
    workerTypes.push("pipeline")
  }

  if (sixb.definitions.projections.list().length > 0) {
    workerTypes.push("projection")
  }

  if (sixb.definitions.actions.list().length > 0) {
    workerTypes.push("action")
  }

  if (
    (sixb.definitions.models !== undefined ||
      sixb.definitions.workflows
        .list()
        .some((workflow) => workflow.nodes.some((node) => node.type === "agent"))) &&
    sixb.storage.agents
  ) {
    workerTypes.push("agent")
  }

  if (sixb.definitions.workflows.list().length > 0) {
    workerTypes.push("workflow")
  }

  return workerTypes
}

function knownWorkers(): string {
  return WORKER_TYPES.join(", ")
}

function isWorkerType(value: string): value is WorkerType {
  return WORKER_TYPES.some((workerType) => workerType === value)
}

function agentApiBaseUrl(value: string | undefined): string | null {
  return configuredOrigin(value, "SIXB_API_PUBLIC_ORIGIN", "API public origin")
}

function resolveAgentApiBaseUrl(value: string | undefined): string {
  const apiBaseUrl = agentApiBaseUrl(value)
  if (!apiBaseUrl) {
    throw new Error(`[SixbWorker] The agent worker ${AGENT_ORIGIN_REQUIRED}.`)
  }
  return apiBaseUrl
}
