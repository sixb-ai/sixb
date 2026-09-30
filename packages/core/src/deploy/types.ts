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
}

export interface DeployListenAddress {
  readonly host: string
  readonly port: number
}
