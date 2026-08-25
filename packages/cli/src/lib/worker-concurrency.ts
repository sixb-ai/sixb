import { WORKER_TYPES, type WorkerConcurrency, type WorkerType } from "./worker-registry"

const CONFIGURABLE_WORKER_TYPES = [
  "sync",
  "agent",
  "pipeline",
  "projection",
  "workflow",
] as const satisfies readonly WorkerType[]

type ConfigurableWorkerType = (typeof CONFIGURABLE_WORKER_TYPES)[number]

const concurrencyEnvironmentVariables = {
  sync: "SIXB_SYNC_WORKER_CONCURRENCY",
  agent: "SIXB_AGENT_WORKER_CONCURRENCY",
  pipeline: "SIXB_PIPELINE_WORKER_CONCURRENCY",
  projection: "SIXB_PROJECTION_WORKER_CONCURRENCY",
  workflow: "SIXB_WORKFLOW_WORKER_CONCURRENCY",
} as const satisfies Record<ConfigurableWorkerType, string>

/** Resolve the scalar concurrency accepted by `sixb worker <type>`. */
export function resolveSingleWorkerConcurrency(
  workerType: WorkerType,
  value: string | undefined
): WorkerConcurrency {
  if (workerType === "action") {
    if (value !== undefined || nonblank(process.env.SIXB_ACTION_WORKER_CONCURRENCY)) {
      throw fixedActionConcurrency()
    }
    return {}
  }

  const environmentVariable = concurrencyEnvironmentVariables[workerType]
  const configured = value?.trim() ?? nonblank(process.env[environmentVariable])
  if (configured === undefined) return {}

  return { [workerType]: parseConcurrency(configured, `--concurrency or ${environmentVariable}`) }
}

/**
 * Resolve repeatable `<type>=<count>` values for co-hosted workers. Per-type CLI values override
 * their environment variables; repeated CLI values use the last occurrence.
 */
export function resolveWorkerConcurrency(values: readonly string[] = []): WorkerConcurrency {
  const resolved: Partial<Record<WorkerType, number>> = {}

  for (const workerType of CONFIGURABLE_WORKER_TYPES) {
    const environmentVariable = concurrencyEnvironmentVariables[workerType]
    const configured = nonblank(process.env[environmentVariable])
    if (configured !== undefined) {
      resolved[workerType] = parseConcurrency(configured, environmentVariable)
    }
  }

  if (nonblank(process.env.SIXB_ACTION_WORKER_CONCURRENCY)) {
    throw fixedActionConcurrency()
  }

  for (const value of values) {
    const entry = parseWorkerConcurrencyEntry(value)
    resolved[entry.workerType] = entry.concurrency
  }

  return resolved
}

function parseWorkerConcurrencyEntry(value: string): {
  readonly workerType: ConfigurableWorkerType
  readonly concurrency: number
} {
  const separator = value.indexOf("=")
  if (separator <= 0 || separator !== value.lastIndexOf("=")) {
    throw invalidWorkerConcurrencyEntry(value)
  }

  const workerType = value.slice(0, separator).trim()
  const configured = value.slice(separator + 1).trim()
  if (!isWorkerType(workerType)) {
    throw new Error(
      `[SixbCLI] Unknown worker concurrency type '${workerType || value}'. Available: ${CONFIGURABLE_WORKER_TYPES.join(", ")}.`
    )
  }
  if (workerType === "action") {
    throw fixedActionConcurrency()
  }

  return {
    workerType,
    concurrency: parseConcurrency(configured, `--concurrency ${workerType}=<count>`),
  }
}

function parseConcurrency(value: string, source: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw invalidConcurrency(value, source)
  }

  const concurrency = Number(value)
  if (!Number.isSafeInteger(concurrency)) {
    throw invalidConcurrency(value, source)
  }
  return concurrency
}

function nonblank(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

function isWorkerType(value: string): value is WorkerType {
  return WORKER_TYPES.some((workerType) => workerType === value)
}

function invalidConcurrency(value: string, source: string): Error {
  return new Error(
    `[SixbCLI] Invalid worker concurrency '${value}'. Use a positive integer with ${source}.`
  )
}

function invalidWorkerConcurrencyEntry(value: string): Error {
  return new Error(
    `[SixbCLI] Invalid worker concurrency '${value}'. Use a repeatable type=count value like ` +
      "--concurrency agent=4 --concurrency sync=2."
  )
}

function fixedActionConcurrency(): Error {
  return new Error("[SixbCLI] Action worker concurrency is fixed at 1 and cannot be configured.")
}
