import { WORKER_TYPES, type WorkerConcurrency, type WorkerType } from "./worker-registry"

/** The environment variable that sets each worker type's concurrency. */
const ENVIRONMENT_VARIABLES = {
  sync: "SIXB_SYNC_WORKER_CONCURRENCY",
  agent: "SIXB_AGENT_WORKER_CONCURRENCY",
  pipeline: "SIXB_PIPELINE_WORKER_CONCURRENCY",
  projection: "SIXB_PROJECTION_WORKER_CONCURRENCY",
  workflow: "SIXB_WORKFLOW_WORKER_CONCURRENCY",
} as const satisfies Record<WorkerType, string>

/** Resolve the scalar concurrency accepted by `sixb worker <type>`. */
export function resolveSingleWorkerConcurrency(
  workerType: WorkerType,
  value: string | undefined
): WorkerConcurrency {
  const environmentVariable = ENVIRONMENT_VARIABLES[workerType]
  const configured = value?.trim() ?? nonblank(process.env[environmentVariable])
  if (configured === undefined) return {}

  return { [workerType]: parseConcurrency(configured, `--concurrency or ${environmentVariable}`) }
}

/**
 * Resolve repeatable `<type>=<count>` values for co-hosted workers. Per-type CLI values override
 * their environment variables; repeated CLI values use the last occurrence.
 */
export function resolveWorkerConcurrency(values: readonly string[] = []): WorkerConcurrency {
  const overrides = values.map(parseWorkerConcurrencyEntry)
  const overriddenWorkerTypes = new Set(overrides.map((entry) => entry.workerType))
  const resolved: Partial<Record<WorkerType, number>> = {}

  for (const workerType of WORKER_TYPES) {
    if (overriddenWorkerTypes.has(workerType)) continue

    const environmentVariable = ENVIRONMENT_VARIABLES[workerType]
    const configured = nonblank(process.env[environmentVariable])
    if (configured !== undefined) {
      resolved[workerType] = parseConcurrency(configured, environmentVariable)
    }
  }

  for (const entry of overrides) {
    resolved[entry.workerType] = entry.concurrency
  }

  return resolved
}

function parseWorkerConcurrencyEntry(value: string): {
  readonly workerType: WorkerType
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
      `[SixbCLI] Unknown worker concurrency type '${workerType || value}'. Available: ${WORKER_TYPES.join(", ")}.`
    )
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
