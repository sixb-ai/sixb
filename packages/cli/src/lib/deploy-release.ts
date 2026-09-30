import type {
  DeployConfig,
  DeployEnv,
  DeployHttpServiceName,
  DeployListenAddress,
  DeployProcessDefinition,
  DeployScalableProcessOptions,
  DeployServiceName,
  DeployWorkersConfig,
} from "@sixb/core/deploy"
import { DEPLOY_SERVICES, isDeployHttpService } from "@sixb/core/internal/deploy"
import { parseAgentTurnTimeoutMs } from "./agent-turn-timeout"
import { SixbCliError } from "./errors"
import { type ProductionRole, productionRoleFacts } from "./production-roles"

/**
 * Everything a deployment runs, resolved from `sixb.deploy.ts` against the CLI's own roles and
 * flags. A target only decides where and how it runs: which processes exist, and the exact
 * command each one starts with, are the framework's answer.
 */
export interface DeployRelease {
  readonly name: string
  readonly target: { readonly kind: string; readonly location: string }
  /** The environment every step and service starts from. */
  readonly env: DeployEnv
  readonly steps: {
    /** Runs while the previous release still serves. */
    readonly build: readonly DeployCommand[]
    /** Runs after the services stop and before they start again. */
    readonly beforeStart: readonly DeployCommand[]
  }
  readonly services: readonly DeployReleaseService[]
}

export interface DeployCommand {
  /** `sixb` is the CLI the project installs; `bun` runs a project script. */
  readonly program: "sixb" | "bun"
  readonly args: readonly string[]
}

export interface DeployReleaseService {
  readonly name: string
  /** The production role the service runs, or `custom` for a project process. */
  readonly role: ProductionRole | "custom"
  readonly command: DeployCommand
  /** The complete environment: the release's, then the service's own additions. */
  readonly env: DeployEnv
  readonly instances: number
  readonly http?: DeployReleaseHttp
  readonly process: DeployReleaseProcess
}

export interface DeployReleaseHttp extends DeployListenAddress {
  readonly domain: string
  readonly publicOrigin: string
}

export interface DeployReleaseProcess {
  readonly killTimeoutMs: number
  readonly restartDelayMs: number
  readonly maxMemory?: string
}

/**
 * The service that deploys each production role. Total over the role union: a new role does not
 * compile until it names its service, or `null` for a role a deployment never runs on its own.
 */
const ROLE_SERVICES = {
  api: "api",
  atlas: "atlas",
  app: "app",
  orchestrator: "orchestrator",
  scheduler: "scheduler",
  rules: "rules",
  "worker-group": "workers",
  // A deployment co-hosts its workers in one `worker-group`; `workers.process.instances` scales it.
  worker: null,
} as const satisfies Record<ProductionRole, DeployServiceName | null>

type RoleOf<Service extends DeployServiceName> = {
  [Role in ProductionRole]: (typeof ROLE_SERVICES)[Role] extends Service ? Role : never
}[ProductionRole]

/** The role behind each service. A service that no role deploys does not compile. */
const SERVICE_ROLES: { readonly [Service in DeployServiceName]: RoleOf<Service> } = {
  api: "api",
  atlas: "atlas",
  app: "app",
  orchestrator: "orchestrator",
  scheduler: "scheduler",
  rules: "rules",
  workers: "worker-group",
}

/** The variable each role reads for a surface's public origin. */
const PUBLIC_ORIGIN_ENV = {
  api: "SIXB_API_PUBLIC_ORIGIN",
  atlas: "SIXB_ATLAS_PUBLIC_ORIGIN",
  app: "SIXB_APP_PUBLIC_ORIGIN",
} as const satisfies Record<DeployHttpServiceName, string>

const DEFAULT_KILL_TIMEOUT_MS = 10_000
const DEFAULT_RESTART_DELAY_MS = 1_000

export function buildDeployRelease(config: DeployConfig): DeployRelease {
  const enabled = DEPLOY_SERVICES.filter((service) => config.services?.[service] !== false)
  const http = resolveHttpServices(config, enabled)

  // Every service gets every origin: the API checks browser origins, and agent workers call it.
  const env: DeployEnv = {
    NODE_ENV: "production",
    ...Object.fromEntries(
      [...http].map(([service, address]) => [PUBLIC_ORIGIN_ENV[service], address.publicOrigin])
    ),
    ...config.env,
  }

  return {
    name: config.name,
    target: { kind: config.target.kind, location: config.target.location },
    env,
    steps: {
      build: [sixb("build")],
      beforeStart: [sixb("db", "migrate"), sixb("lake", "check")],
    },
    services: [
      ...enabled.map((service) => sixbService(config, service, env, http)),
      ...Object.entries(config.processes ?? {}).map(([name, definition]) =>
        projectProcess(name, definition, env)
      ),
    ],
  }
}

function sixbService(
  config: DeployConfig,
  service: DeployServiceName,
  env: DeployEnv,
  http: ReadonlyMap<DeployHttpServiceName, DeployReleaseHttp>
): DeployReleaseService {
  const role = SERVICE_ROLES[service]
  const override = config.services?.[service]
  const options = typeof override === "object" ? override : {}
  const address = isDeployHttpService(service) ? http.get(service) : undefined
  // The release migrates storage once, before any service starts, so no service races it.
  const noMigrate = productionRoleFacts(role).usesStorageSchema ? ["--no-migrate"] : []

  const workers = config.services?.workers
  const args = address
    ? [role, "--host", address.host, "--port", String(address.port)]
    : service === "workers"
      ? workerGroupArgs(typeof workers === "object" ? workers : {})
      : [role]

  const processOptions: DeployScalableProcessOptions = options.process ?? {}
  return {
    name: service,
    role,
    command: { program: "sixb", args: [...args, ...noMigrate] },
    env: { ...env, ...options.env },
    instances: processOptions.instances ?? 1,
    ...(address ? { http: address } : {}),
    process: releaseProcess(processOptions),
  }
}

function workerGroupArgs(options: DeployWorkersConfig): string[] {
  const types = options.types === undefined || options.types === "all" ? [] : options.types
  const args = ["worker-group", ...types]

  if (options.agentTurnTimeout !== undefined) {
    if (parseAgentTurnTimeoutMs(options.agentTurnTimeout) === null) {
      throw new SixbCliError(
        `[SixbDeploy] services.workers.agentTurnTimeout '${options.agentTurnTimeout}' is not a ` +
          "duration.",
        { remediation: 'Use a positive duration such as "30s", "10m", or "1h".' }
      )
    }
    args.push("--agent-turn-timeout", options.agentTurnTimeout)
  }
  for (const [workerType, concurrency] of Object.entries(options.concurrency ?? {})) {
    args.push("--concurrency", `${workerType}=${concurrency}`)
  }
  return args
}

function projectProcess(
  name: string,
  definition: DeployProcessDefinition,
  env: DeployEnv
): DeployReleaseService {
  const processOptions = definition.process ?? {}
  return {
    name,
    role: "custom",
    command: { program: "bun", args: [definition.entrypoint, ...(definition.args ?? [])] },
    env: { ...env, ...definition.env },
    instances: processOptions.instances ?? 1,
    process: releaseProcess(processOptions),
  }
}

function resolveHttpServices(
  config: DeployConfig,
  enabled: readonly DeployServiceName[]
): Map<DeployHttpServiceName, DeployReleaseHttp> {
  const resolved = new Map<DeployHttpServiceName, DeployReleaseHttp>()
  const domains = new Map<string, DeployHttpServiceName>()
  const ports = new Map<number, DeployHttpServiceName>()

  for (const service of enabled.filter(isDeployHttpService)) {
    const override = config.services?.[service]
    const domain =
      (typeof override === "object" ? override.domain : undefined) ?? defaultDomain(config, service)
    const address = config.target.listenAddress(service)

    const sharedDomain = domains.get(domain.toLowerCase())
    if (sharedDomain) {
      throw new SixbCliError(
        `[SixbDeploy] services.${sharedDomain} and services.${service} both use ${domain}.`,
        { remediation: "Give each HTTP service its own domain." }
      )
    }
    const sharedPort = ports.get(address.port)
    if (sharedPort) {
      throw new SixbCliError(
        `[SixbDeploy] ${sharedPort} and ${service} both listen on port ${address.port}.`,
        { remediation: "Give each HTTP service its own port in the target's `ports`." }
      )
    }
    domains.set(domain.toLowerCase(), service)
    ports.set(address.port, service)
    resolved.set(service, { ...address, domain, publicOrigin: `https://${domain}` })
  }

  return resolved
}

function defaultDomain(config: DeployConfig, service: DeployHttpServiceName): string {
  const label = `${config.name}-${service}`
  if (config.domain === undefined) {
    throw new SixbCliError(`[SixbDeploy] services.${service} has no domain.`, {
      remediation:
        `Set \`domain\` to serve it at ${label}.<domain>, set services.${service}.domain, or ` +
        `turn it off with \`${service}: false\`.`,
    })
  }
  // A hostname label holds at most 63 characters.
  if (label.length > 63) {
    throw new SixbCliError(
      `[SixbDeploy] The default domain ${label}.${config.domain} is too long.`,
      {
        remediation: `Set services.${service}.domain.`,
      }
    )
  }
  return `${label}.${config.domain}`
}

function releaseProcess(options: DeployScalableProcessOptions): DeployReleaseProcess {
  return {
    killTimeoutMs: options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
    restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
    ...(options.maxMemory === undefined ? {} : { maxMemory: options.maxMemory.trim() }),
  }
}

function sixb(...args: string[]): DeployCommand {
  return { program: "sixb", args }
}
