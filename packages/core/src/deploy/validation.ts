import {
  DEPLOY_SERVICES,
  DEPLOY_WORKER_TYPES,
  isDeployHttpService,
  isDeploySingletonService,
} from "./services"
import type { DeployConfig } from "./types"

type UnknownRecord = Record<string, unknown>

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const DOMAIN_PATTERN = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`, "i")
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/
const MEMORY_PATTERN = /^\d+(?:\.\d+)?\s*(?:b|k|kb|m|mb|g|gb)?$/i
/** Longest delay a timer honors; anything larger fires immediately. */
const MAX_TIMER_MS = 2_147_483_647

const PROCESS_OPTIONS = ["killTimeoutMs", "restartDelayMs", "maxMemory"] as const
const SCALABLE_PROCESS_OPTIONS = [...PROCESS_OPTIONS, "instances"] as const

/**
 * Checks a loaded `sixb.deploy.ts` default export and returns it typed. Validates shape and
 * values only; `sixb deploy` resolves defaults and checks what depends on the target.
 */
export function validateDeployConfig(value: unknown): DeployConfig {
  const config = record(value, "The deploy config")
  knownKeys(config, ["name", "domain", "target", "env", "services", "processes"], "")

  name(config.name, "name")
  if (config.domain !== undefined) domain(config.domain, "domain")
  target(config.target)
  if (config.env !== undefined) env(config.env, "env")
  if (config.services !== undefined) services(config.services)
  if (config.processes !== undefined) processes(config.processes)

  return value as DeployConfig
}

function target(value: unknown): void {
  const hint = "Use a deploy target, such as `new SshTarget({ host })` from @sixb/deploy-ssh."
  if (typeof value !== "object" || value === null) {
    throw new Error(`[SixbDeploy] target is required. ${hint}`)
  }
  const candidate = value as UnknownRecord
  const methods = ["listenAddress", "deploy", "status", "logs", "control", "check"]
  if (
    typeof candidate.kind !== "string" ||
    typeof candidate.location !== "string" ||
    methods.some((method) => typeof candidate[method] !== "function")
  ) {
    throw new Error(`[SixbDeploy] target is not a deploy target. ${hint}`)
  }
}

function services(value: unknown): void {
  const config = record(value, "services")
  knownKeys(config, DEPLOY_SERVICES, "services")

  for (const service of DEPLOY_SERVICES) {
    const override = config[service]
    if (override === undefined || typeof override === "boolean") continue
    const path = `services.${service}`
    const options = record(override, path)

    if (isDeployHttpService(service)) {
      knownKeys(options, ["domain", "env", "process"], path, {
        port: "Ports belong to the target, such as `new SshTarget({ ports: { api: 3012 } })`.",
      })
      if (options.domain !== undefined) domain(options.domain, `${path}.domain`)
      if (options.process !== undefined) {
        processOptions(options.process, `${path}.process`, PROCESS_OPTIONS, {
          instances: "HTTP services run one process each.",
        })
      }
    } else if (isDeploySingletonService(service)) {
      knownKeys(options, ["env", "process"], path)
      if (options.process !== undefined) {
        processOptions(options.process, `${path}.process`, PROCESS_OPTIONS, {
          instances: `The ${service} runs exactly one process: a second would duplicate its work.`,
        })
      }
    } else {
      knownKeys(options, ["types", "agentTurnTimeout", "concurrency", "env", "process"], path)
      if (options.types !== undefined) workerTypes(options.types, `${path}.types`)
      if (options.agentTurnTimeout !== undefined) {
        string(options.agentTurnTimeout, `${path}.agentTurnTimeout`)
      }
      if (options.concurrency !== undefined) {
        workerConcurrency(options.concurrency, `${path}.concurrency`)
      }
      if (options.process !== undefined) {
        processOptions(options.process, `${path}.process`, SCALABLE_PROCESS_OPTIONS)
      }
    }

    if (options.env !== undefined) env(options.env, `${path}.env`)
  }
}

function processes(value: unknown): void {
  const config = record(value, "processes")

  for (const [processName, definition] of Object.entries(config)) {
    const path = `processes.${processName}`
    name(processName, path)
    if ((DEPLOY_SERVICES as readonly string[]).includes(processName)) {
      throw new Error(`[SixbDeploy] ${path} uses the name of a Sixb service. Rename the process.`)
    }

    const options = record(definition, path)
    knownKeys(options, ["entrypoint", "args", "env", "process"], path)
    entrypoint(options.entrypoint, `${path}.entrypoint`)
    if (options.args !== undefined) {
      if (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== "string")) {
        throw new Error(`[SixbDeploy] ${path}.args must be an array of strings.`)
      }
    }
    if (options.env !== undefined) env(options.env, `${path}.env`)
    if (options.process !== undefined) {
      processOptions(options.process, `${path}.process`, SCALABLE_PROCESS_OPTIONS)
    }
  }
}

function workerTypes(value: unknown, path: string): void {
  if (value === "all") return
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`[SixbDeploy] ${path} must be "all" or a non-empty list of worker types.`)
  }
  const seen = new Set<string>()
  for (const workerType of value) {
    if (workerType === "action") throw removedActionWorker(path)
    if (!(DEPLOY_WORKER_TYPES as readonly unknown[]).includes(workerType)) {
      throw new Error(
        `[SixbDeploy] ${path} has unknown worker type ${JSON.stringify(workerType)}. ` +
          `Available: ${DEPLOY_WORKER_TYPES.join(", ")}.`
      )
    }
    if (seen.has(workerType)) {
      throw new Error(`[SixbDeploy] ${path} lists ${workerType} more than once.`)
    }
    seen.add(workerType)
  }
}

function workerConcurrency(value: unknown, path: string): void {
  const config = record(value, path)
  for (const [workerType, concurrency] of Object.entries(config)) {
    if (workerType === "action") throw removedActionWorker(path)
    if (!(DEPLOY_WORKER_TYPES as readonly string[]).includes(workerType)) {
      throw new Error(
        `[SixbDeploy] ${path} has unknown worker type "${workerType}". ` +
          `Available: ${DEPLOY_WORKER_TYPES.join(", ")}.`
      )
    }
    positiveInteger(concurrency, `${path}.${workerType}`)
  }
}

/** `"action"` was a worker type until Actions ran in the process that requests them. */
function removedActionWorker(path: string): Error {
  return new Error(
    `[SixbDeploy] ${path} names "action", which is no longer a worker type: Actions run in the ` +
      "process that requests them (API, workflows, syncs). Remove it."
  )
}

function processOptions(
  value: unknown,
  path: string,
  allowed: readonly string[],
  hints: Readonly<Record<string, string>> = {}
): void {
  const options = record(value, path)
  knownKeys(options, allowed, path, hints)
  if (options.instances !== undefined) positiveInteger(options.instances, `${path}.instances`)
  if (options.killTimeoutMs !== undefined) {
    positiveInteger(options.killTimeoutMs, `${path}.killTimeoutMs`, MAX_TIMER_MS)
  }
  if (options.restartDelayMs !== undefined) {
    positiveInteger(options.restartDelayMs, `${path}.restartDelayMs`, MAX_TIMER_MS)
  }
  if (options.maxMemory !== undefined) {
    if (typeof options.maxMemory !== "string" || !MEMORY_PATTERN.test(options.maxMemory.trim())) {
      throw new Error(`[SixbDeploy] ${path}.maxMemory must be a size such as "512M" or "2G".`)
    }
  }
}

function entrypoint(value: unknown, path: string): void {
  string(value, path)
  const segments = value.split(/[\\/]/)
  if (value.startsWith("/") || segments.includes("..")) {
    throw new Error(
      `[SixbDeploy] ${path} must be a path inside the project, relative to its directory.`
    )
  }
}

function env(value: unknown, path: string): void {
  const variables = record(value, path)
  for (const [key, variable] of Object.entries(variables)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new Error(
        `[SixbDeploy] ${path}.${key} is not a valid environment variable name. ` +
          "Use uppercase letters, digits, and underscores."
      )
    }
    if (typeof variable !== "string") {
      throw new Error(`[SixbDeploy] ${path}.${key} must be a string.`)
    }
  }
}

function name(value: unknown, path: string): void {
  string(value, path)
  if (!NAME_PATTERN.test(value) || value.length > 63) {
    throw new Error(
      `[SixbDeploy] ${path} must use lowercase letters, numbers, and hyphens, ` +
        "start and end with a letter or number, and be at most 63 characters."
    )
  }
}

function domain(value: unknown, path: string): void {
  string(value, path)
  if (value.includes("://") || value.includes("/")) {
    throw new Error(`[SixbDeploy] ${path} must be a hostname such as app.example.com, not a URL.`)
  }
  if (value.length > 253 || !DOMAIN_PATTERN.test(value)) {
    throw new Error(`[SixbDeploy] ${path} must be a valid hostname such as app.example.com.`)
  }
}

function positiveInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`[SixbDeploy] ${path} must be a positive integer.`)
  }
}

function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[SixbDeploy] ${path} must be a non-empty string.`)
  }
}

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[SixbDeploy] ${path} must be an object.`)
  }
  return value as UnknownRecord
}

function knownKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string,
  hints: Readonly<Record<string, string>> = {}
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    const setting = path ? `${path}.${key}` : key
    const hint = hints[key] ?? `Available: ${allowed.join(", ")}.`
    throw new Error(`[SixbDeploy] Unknown deploy setting '${setting}'. ${hint}`)
  }
}
