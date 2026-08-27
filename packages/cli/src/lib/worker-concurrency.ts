import {
  type ConfigurableWorkerType,
  WORKER_CONCURRENCY_CONFIG,
  WORKER_TYPES,
  type WorkerConcurrency,
  type WorkerType,
} from "./worker-registry"

/** Resolve the scalar concurrency accepted by `sixb worker <type>`. */
export function resolveSingleWorkerConcurrency(
  workerType: WorkerType,
  value: string | undefined
): WorkerConcurrency {
  const definition = WORKER_CONCURRENCY_CONFIG[workerType]
  if (!isConfigurableWorkerType(workerType)) {
    if (value !== undefined || nonblank(process.env[definition.environmentVariable])) {
      throw fixedActionConcurrency()
    }
    return {}
  }

  const environmentVariable = definition.environmentVariable
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
  const resolved: Partial<Record<ConfigurableWorkerType, number>> = {}

  for (const workerType of WORKER_TYPES) {
    const definition = WORKER_CONCURRENCY_CONFIG[workerType]
    if (!isConfigurableWorkerType(workerType)) {
      if (nonblank(process.env[definition.environmentVariable])) {
        throw fixedActionConcurrency()
      }
      continue
    }
    if (overriddenWorkerTypes.has(workerType)) continue

    const environmentVariable = definition.environmentVariable
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
      `[SixbCLI] Unknown worker concurrency type '${workerType || value}'. Available: ${WORKER_TYPES.filter(isConfigurableWorkerType).join(", ")}.`
    )
  }
  if (!isConfigurableWorkerType(workerType)) {
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

function isConfigurableWorkerType(value: WorkerType): value is ConfigurableWorkerType {
  return WORKER_CONCURRENCY_CONFIG[value].configurable
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
