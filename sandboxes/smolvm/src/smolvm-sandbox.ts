import { randomUUID } from "node:crypto"
import {
  type CommandResult,
  type CreateSandboxOptions,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxNetworkPolicy,
  SandboxNotRunningError,
  type SandboxStatus,
} from "@sixb/core"
import {
  buildCreateArgv,
  buildExecArgv,
  buildRemoveArgv,
  buildStartArgv,
  buildStopArgv,
  isLocalImageArchive,
  type SmolvmCliConfig,
} from "./cli"
import { exec } from "./exec"
import { buildNetworkFlags, withRegistryEgress } from "./network"
import { cleanupWorkdir, type ResolvedWorkdir, resolveWorkdir } from "./workdir"

export interface SmolvmSandboxOptions extends CreateSandboxOptions {
  readonly id?: string
  readonly cli: SmolvmCliConfig
  /**
   * Registry hosts to add to a restricted network policy when an image is set,
   * so the in-guest pull at start can reach the registry. Ignored for bare
   * machines (no image) and for "all"/"none" policies.
   */
  readonly registryHosts?: readonly string[]
}

/**
 * Host environment forwarded to the smolvm CLI process itself (not the guest).
 * smolvm needs these to locate its state dir and helper binaries. Guest env is
 * passed separately via smolvm's `--env` flags (see buildExecArgv in cli.ts).
 */
const HOST_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "SMOLVM_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const

export class SmolvmSandbox implements Sandbox {
  readonly id: string
  readonly provider = "smolvm"
  readonly workingDirectory: string

  private currentStatus: SandboxStatus = "running"
  private readonly cli: SmolvmCliConfig
  private readonly workdir: ResolvedWorkdir
  private readonly sandboxEnv: Readonly<Record<string, string>>
  private readonly defaultTimeoutMs: number | undefined
  private readonly inFlight = new Set<AbortController>()

  private constructor(input: {
    readonly id: string
    readonly workdir: ResolvedWorkdir
    readonly cli: SmolvmCliConfig
    readonly env: Readonly<Record<string, string>>
    readonly timeout: number | undefined
  }) {
    this.id = input.id
    this.workdir = input.workdir
    this.workingDirectory = input.workdir.dir
    this.cli = input.cli
    this.sandboxEnv = input.env
    this.defaultTimeoutMs = input.timeout
  }

  get status(): SandboxStatus {
    return this.currentStatus
  }

  static async create(options: SmolvmSandboxOptions): Promise<SmolvmSandbox> {
    const id = options.id ?? randomUUID()
    const workdir = await resolveWorkdir(options.workingDirectory)
    // A registry image pulls at start, so it needs the registry on the allow
    // list. A local image archive and a bare machine both boot offline, so they
    // stay locked to the given policy (no registry egress).
    const basePolicy = options.network ?? { mode: "none" }
    warnIfLoopbackGateway(basePolicy)
    const needsRegistry = options.cli.image !== undefined && !isLocalImageArchive(options.cli.image)
    const policy = needsRegistry
      ? withRegistryEgress(basePolicy, options.registryHosts ?? [])
      : basePolicy
    const network = buildNetworkFlags(policy)

    try {
      const created = await exec({
        argv: buildCreateArgv(options.cli, { id, network, volume: workdir.volume }),
        cwd: workdir.dir,
        env: hostEnv(),
      })
      if (created.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] smolvm create failed for ${id}: ${created.stderr.trim() || `exit ${created.exitCode}`}`
        )
      }

      const started = await exec({
        argv: buildStartArgv(options.cli, id),
        cwd: workdir.dir,
        env: hostEnv(),
      })
      if (started.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] smolvm start failed for ${id}: ${started.stderr.trim() || `exit ${started.exitCode}`}`
        )
      }
    } catch (error) {
      // Best-effort cleanup of a half-created machine and its host workdir.
      await exec({ argv: buildRemoveArgv(options.cli, id), cwd: workdir.dir, env: hostEnv() })
      await cleanupWorkdir(workdir)
      throw error
    }

    return new SmolvmSandbox({
      id,
      workdir,
      cli: options.cli,
      env: options.env ?? {},
      timeout: options.timeout,
    })
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${this.currentStatus}; cannot run commands`
      )
    }

    const env = { ...this.sandboxEnv, ...(options.env ?? {}) }
    const cwd = options.cwd ?? this.workdir.dir
    const timeoutMs = options.timeout ?? this.defaultTimeoutMs

    const controller = new AbortController()
    const onUserAbort = (): void => controller.abort()
    options.signal?.addEventListener("abort", onUserAbort)
    if (options.signal?.aborted) {
      onUserAbort()
    }
    this.inFlight.add(controller)

    try {
      return await exec({
        argv: buildExecArgv(this.cli, { id: this.id, cwd, command, args, env }),
        cwd: this.workdir.dir,
        env: hostEnv(),
        timeoutMs,
        signal: controller.signal,
      })
    } finally {
      this.inFlight.delete(controller)
      options.signal?.removeEventListener("abort", onUserAbort)
    }
  }

  async stop(): Promise<void> {
    if (this.currentStatus !== "running") {
      return
    }
    this.currentStatus = "stopped"
    for (const controller of this.inFlight) {
      controller.abort()
    }
    this.inFlight.clear()
    // Best-effort: exec never throws, and a failed stop must not fail the run.
    await exec({ argv: buildStopArgv(this.cli, this.id), cwd: this.workdir.dir, env: hostEnv() })
  }

  async destroy(): Promise<void> {
    if (this.currentStatus === "running") {
      await this.stop()
    }
    await exec({ argv: buildRemoveArgv(this.cli, this.id), cwd: this.workdir.dir, env: hostEnv() })
    await cleanupWorkdir(this.workdir)
  }
}

let warnedLoopbackGateway = false

/**
 * A microVM has its own network stack, so a gateway advertised on localhost is
 * unreachable from inside it under restricted egress. Warn once with the fix
 * rather than letting the agent fail silently with connection-refused.
 */
function warnIfLoopbackGateway(policy: SandboxNetworkPolicy): void {
  if (warnedLoopbackGateway || policy.mode !== "restricted") {
    return
  }
  const loopback = policy.allow.find((target) => isLoopbackOrigin(target.origin))
  if (loopback) {
    warnedLoopbackGateway = true
    console.warn(
      `[Sandbox] smolvm runs in a VM and cannot reach the gateway at ${loopback.origin} over localhost. ` +
        "Set the API public origin to the host's LAN IP (e.g. SIXB_API_PUBLIC_ORIGIN=http://<lan-ip>:<port>)."
    )
  }
}

function isLoopbackOrigin(origin: string): boolean {
  let host = origin
  try {
    host = new URL(origin).hostname
  } catch {
    // fall through with the raw value
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
}

function hostEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}
