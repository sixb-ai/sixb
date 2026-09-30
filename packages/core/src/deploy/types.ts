/**
 * A deployment of this project: which services run, how browsers reach them, and the target that
 * runs them. `sixb deploy` loads it from `sixb.deploy.ts`; the running app never reads it.
 */
export interface DeployConfig {
  /**
   * Names the deployment on its target and in default domains. Lowercase letters, numbers, and
   * hyphens.
   */
  readonly name: string
  /**
   * Parent domain for HTTP services without their own `domain`: `<name>-<service>.<domain>`.
   * Required unless every enabled HTTP service sets `domain`.
   */
  readonly domain?: string
  /** Where the services run, such as `new SshTarget({ host })` from `@sixb/deploy-ssh`. */
  readonly target: DeployTarget
  /**
   * Environment for every service and release step. Committed with the project, so secrets
   * belong in the target's `.env` instead.
   */
  readonly env?: DeployEnv
  /** Override or disable the Sixb services. Every service runs unless set to `false`. */
  readonly services?: DeployServicesConfig
  /** Long-running project scripts, supervised alongside the Sixb services. */
  readonly processes?: Readonly<Record<string, DeployProcessDefinition>>
}

export type DeployEnv = Readonly<Record<string, string>>

/** The services a browser or client reaches through a public domain. */
export type DeployHttpServiceName = "api" | "atlas" | "app"

/** The services that must run as exactly one process: a second would duplicate their work. */
export type DeploySingletonServiceName = "orchestrator" | "scheduler" | "rules"

export type DeployServiceName = DeployHttpServiceName | DeploySingletonServiceName | "workers"

export type DeployWorkerType = "sync" | "action" | "agent" | "pipeline" | "projection" | "workflow"

/** Action jobs run one at a time, so their concurrency is fixed. */
export type DeployConfigurableWorkerType = Exclude<DeployWorkerType, "action">

export interface DeployServicesConfig {
  readonly api?: boolean | DeployHttpServiceConfig
  readonly atlas?: boolean | DeployHttpServiceConfig
  readonly app?: boolean | DeployHttpServiceConfig
  readonly orchestrator?: boolean | DeploySingletonServiceConfig
  readonly scheduler?: boolean | DeploySingletonServiceConfig
  readonly rules?: boolean | DeploySingletonServiceConfig
  readonly workers?: boolean | DeployWorkersConfig
}

export interface DeployHttpServiceConfig {
  /** Public hostname. Defaults to `<name>-<service>.<domain>`. */
  readonly domain?: string
  /** Added to the deployment's `env` for this service only. */
  readonly env?: DeployEnv
  readonly process?: DeployProcessOptions
}

export interface DeploySingletonServiceConfig {
  /** Added to the deployment's `env` for this service only. */
  readonly env?: DeployEnv
  readonly process?: DeployProcessOptions
}

export interface DeployWorkersConfig {
  /**
   * The worker types to run. `"all"`, the default, runs every type the project registers work
   * for.
   */
  readonly types?: readonly DeployWorkerType[] | "all"
  /** Wall-clock budget for one agent turn, such as `"30s"`, `"10m"`, or `"1h"`. */
  readonly agentTurnTimeout?: string
  /** Jobs each worker type runs at once inside one process. */
  readonly concurrency?: Readonly<Partial<Record<DeployConfigurableWorkerType, number>>>
  /** Added to the deployment's `env` for the workers only. */
  readonly env?: DeployEnv
  readonly process?: DeployScalableProcessOptions
}

export interface DeployProcessDefinition {
  /** Script to run with Bun, relative to the project directory. */
  readonly entrypoint: string
  readonly args?: readonly string[]
  /** Added to the deployment's `env` for this process only. */
  readonly env?: DeployEnv
  readonly process?: DeployScalableProcessOptions
}

export interface DeployProcessOptions {
  /** How long a stopping process may take before it is killed. Defaults to 10000. */
  readonly killTimeoutMs?: number
  /** Wait before restarting a process that exited, growing with each restart. Defaults to 1000. */
  readonly restartDelayMs?: number
  /** Restart the process when its memory passes this size, such as `"512M"` or `"2G"`. */
  readonly maxMemory?: string
}

export interface DeployScalableProcessOptions extends DeployProcessOptions {
  /** How many copies of the process to run. Defaults to 1. */
  readonly instances?: number
}

/**
 * Runs a deployment. `@sixb/deploy-ssh` provides the SSH target. Third-party targets are not
 * supported in 0.1.x: this contract still grows with each thing `sixb deploy` learns to do.
 */
export interface DeployTarget {
  /** The kind of target, shown in `sixb deploy` output, such as `"ssh"`. */
  readonly kind: string
  /** Where the deployment runs, shown in output, such as `"sixb@203.0.113.10"`. */
  readonly location: string
  /** The address an HTTP service listens on, where the target's proxy reaches it. */
  listenAddress(service: DeployHttpServiceName): DeployListenAddress
  /**
   * Ships the source, runs the release, and resolves once its services answer. Rejects with the
   * reason when a step fails; the steps it reported say how far it got.
   */
  deploy(release: DeployRelease, source: DeploySource, context: DeployContext): Promise<void>
  /** What the deployment runs right now, and which release it runs. */
  status(context: DeployOperationContext): Promise<DeployStatus>
  /** Writes recent log lines, then new ones as they arrive when `follow` is set. */
  logs(options: DeployLogsOptions, context: DeployOperationContext): Promise<void>
  /** Restarts, stops, or starts one service, or every service. */
  control(
    action: DeployControlAction,
    service: string | undefined,
    context: DeployOperationContext
  ): Promise<void>
  /** What stands between the target and a working deploy of the release, changing nothing. */
  check(release: DeployRelease, context: DeployCheckContext): Promise<readonly DeployCheck[]>
  /** Prepares the target for the release, fixing what `check` reports as fixable. */
  setup?(release: DeployRelease, context: DeploySetupContext): Promise<void>
  /** Who may deploy and operate the deployment, for a target reached with keys. */
  readonly access?: DeployAccess
}

export interface DeployCheck {
  readonly id: string
  /** What was checked, such as `"SSH"` or `"api DNS"`. */
  readonly label: string
  /**
   * `fixable`: `sixb deploy setup` fixes it. `manual`: only you can, as `remedy` says. Both stop
   * a deploy; a `warning` does not.
   */
  readonly status: "ok" | "fixable" | "manual" | "warning"
  readonly detail: string
  /** What to do about it, when the status is not `ok`. */
  readonly remedy?: string
}

export interface DeployCheckContext extends DeployOperationContext {
  /** The project's directory inside its repository: `.` at the root. */
  readonly projectPath: string
}

export interface DeploySetupContext extends DeployCheckContext {
  /** The account with sudo that prepares a server, for a target that needs one. */
  readonly admin?: string
  /** A public key file to authorize for deploys, instead of the one the target would pick. */
  readonly key?: string
  /** A line of progress for the person running setup. */
  write(line: string): void
}

export interface DeployAccess {
  list(context: DeployOperationContext): Promise<readonly DeployAccessKey[]>
  /** Authorizes a public key, given as its text (`ssh-ed25519 AAAA… comment`). */
  add(key: string, context: DeployOperationContext): Promise<DeployAccessKey>
  /** Revokes the keys whose fingerprint or comment matches, and returns them. */
  remove(match: string, context: DeployOperationContext): Promise<readonly DeployAccessKey[]>
}

export interface DeployAccessKey {
  readonly type: string
  readonly fingerprint: string
  readonly comment: string
  /** Whether the key is limited to running commands: no forwarding, no terminal. */
  readonly restricted: boolean
}

export interface DeployListenAddress {
  readonly host: string
  readonly port: number
}

/**
 * Everything a deployment runs, resolved by `sixb deploy` from `sixb.deploy.ts`. A target decides
 * where and how it runs; which processes exist, and the command each one starts with, come from
 * Sixb.
 */
export interface DeployRelease {
  readonly name: string
  readonly target: { readonly kind: string; readonly location: string }
  /** The Bun version the project runs on. */
  readonly bunVersion: string
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
  readonly kind: "http" | "singleton" | "workers" | "script"
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
  /** Answers once the service can take traffic, when the service has such a route. */
  readonly readinessPath?: string
}

export interface DeployReleaseProcess {
  readonly killTimeoutMs: number
  readonly restartDelayMs: number
  readonly maxMemory?: string
}

/** The committed files a deployment runs, read from git by `sixb deploy`. */
export interface DeploySource {
  /** The commit being deployed. */
  readonly commit: string
  /** What the deployer asked for, such as `HEAD` or `main`. */
  readonly ref: string
  /** The project's directory inside the repository: `.` at its root. */
  readonly projectPath: string
  /** Tar archives of the committed files: the repository first, then each submodule. */
  readonly archives: readonly DeploySourceArchive[]
}

export interface DeploySourceArchive {
  /** Where the archive's files belong, relative to the repository root: `.` for the root. */
  readonly path: string
  open(): ReadableStream<Uint8Array>
}

export interface DeployOperationContext {
  /** The deployment's `name`, which a target may run several of. */
  readonly name: string
}

export interface DeployContext extends DeployOperationContext {
  /** Who deployed, recorded with the release. */
  readonly deployedBy: string
  report(event: DeployEvent): void
}

export type DeployEvent =
  /** The steps the deployment will run, reported before the first one starts. */
  | { readonly type: "steps"; readonly labels: readonly string[] }
  | { readonly type: "step"; readonly index: number; readonly status: "running" | "done" }
  | { readonly type: "output"; readonly line: string }

export interface DeployStatus {
  /** The release the target last deployed, if any. */
  readonly release: DeployRecord | null
  /** Whether the target's process supervisor is running. */
  readonly running: boolean
  readonly processes: readonly DeployProcessStatus[]
}

export interface DeployRecord {
  readonly commit: string
  readonly ref: string
  readonly deployedAt: string
  readonly deployedBy: string
}

export interface DeployProcessStatus {
  readonly service: string
  readonly instance: number
  readonly status: "starting" | "running" | "stopping" | "stopped" | "exited"
  readonly pid?: number
  readonly restarts: number
  readonly startedAt?: string
  readonly cpuPercent?: number
  readonly memoryBytes?: number
  readonly lastError?: string
}

export interface DeployLogsOptions {
  /** One service's logs, or every service's. */
  readonly service?: string
  /** How many recent lines to write first. */
  readonly tail: number
  readonly follow: boolean
  write(line: string): void
}

export type DeployControlAction = "restart" | "start" | "stop"
