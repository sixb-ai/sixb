import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CommandResult,
  type CreateSandboxOptions,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  SandboxNotRunningError,
  type SandboxStatus,
} from "@sixb/core"
import {
  type AppleContainerCliConfig,
  buildCreateArgv,
  buildDeleteArgv,
  buildExecArgv,
  buildNetworkCreateArgv,
  buildNetworkDeleteArgv,
  buildStartArgv,
  buildStopArgv,
} from "./cli"
import {
  type AppleContainerNetworkResolution,
  resolveAppleContainerNetwork,
  warnIfRestrictedDowngraded,
} from "./network"
import { runAppleContainerCli } from "./process"

export interface AppleContainerSandboxOptions extends CreateSandboxOptions {
  readonly id?: string
  readonly cli: AppleContainerCliConfig
  /** Network attached for mode=all and downgraded mode=restricted. Defaults to Apple's default. */
  readonly defaultNetworkName?: string
  /** Prefix for per-sandbox internal networks used by mode=none. */
  readonly internalNetworkPrefix?: string
  /** Timeout for provider bootstrap/cleanup commands, in milliseconds. */
  readonly setupTimeoutMs?: number
}

const DEFAULT_WORKING_DIRECTORY = "/workspace"
const DEFAULT_NETWORK_NAME = "default"
const DEFAULT_INTERNAL_NETWORK_PREFIX = "sixb-apple-net-"
const DEFAULT_SETUP_TIMEOUT_MS = 30_000
const HOST_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "SSH_AUTH_SOCK",
] as const
const WRITE_FILE_SCRIPT =
  'mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && if [ -n "$2" ]; then chmod "$2" "$1"; fi'

export class AppleContainerSandbox implements Sandbox {
  readonly id: string
  readonly provider = "apple-container"
  readonly workingDirectory: string

  private currentStatus: SandboxStatus = "running"
  private readonly cli: AppleContainerCliConfig
  private readonly sandboxEnv: Readonly<Record<string, string>>
  private readonly defaultTimeoutMs: number | undefined
  private readonly network: AppleContainerNetworkResolution
  private readonly setupTimeoutMs: number
  private readonly inFlight = new Set<AbortController>()
  private containerDeleted = false
  private networkDeleted: boolean
  private destroyed = false

  private constructor(input: {
    readonly id: string
    readonly cli: AppleContainerCliConfig
    readonly workingDirectory: string
    readonly env: Readonly<Record<string, string>>
    readonly timeout: number | undefined
    readonly network: AppleContainerNetworkResolution
    readonly setupTimeoutMs: number
  }) {
    this.id = input.id
    this.cli = input.cli
    this.workingDirectory = input.workingDirectory
    this.sandboxEnv = input.env
    this.defaultTimeoutMs = input.timeout
    this.network = input.network
    this.setupTimeoutMs = input.setupTimeoutMs
    this.networkDeleted = input.network.ownedNetworkName === undefined
  }

  get status(): SandboxStatus {
    return this.currentStatus
  }

  static async create(options: AppleContainerSandboxOptions): Promise<AppleContainerSandbox> {
    const id = options.id ?? `sixb-apple-${randomUUID()}`
    const workingDirectory = normalizeWorkingDirectory(options.workingDirectory)
    const networkPolicy = options.network ?? { mode: "none" }
    warnIfRestrictedDowngraded(networkPolicy)
    const network = resolveAppleContainerNetwork({
      id,
      policy: networkPolicy,
      defaultNetworkName: options.defaultNetworkName ?? DEFAULT_NETWORK_NAME,
      internalNetworkPrefix: options.internalNetworkPrefix ?? DEFAULT_INTERNAL_NETWORK_PREFIX,
    })
    const setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS
    let networkCreated = false

    try {
      if (network.ownedNetworkName !== undefined) {
        const createdNetwork = await runAppleContainerCli({
          argv: buildNetworkCreateArgv(options.cli.bin, network.ownedNetworkName),
          cwd: process.cwd(),
          env: hostEnv(),
          timeoutMs: setupTimeoutMs,
        })
        if (createdNetwork.exitCode !== 0) {
          throw new SandboxError(
            `[Sandbox] apple-container network create failed for ${network.ownedNetworkName}: ${errorText(createdNetwork)}`
          )
        }
        networkCreated = true
      }

      const created = await runAppleContainerCli({
        argv: buildCreateArgv(options.cli, {
          id,
          workingDirectory,
          env: options.env ?? {},
          networkArgs: network.createArgs,
        }),
        cwd: process.cwd(),
        env: hostEnv(),
        timeoutMs: setupTimeoutMs,
      })
      if (created.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] apple-container create failed for ${id}: ${errorText(created)}`
        )
      }

      const started = await runAppleContainerCli({
        argv: buildStartArgv(options.cli, id),
        cwd: process.cwd(),
        env: hostEnv(),
        timeoutMs: setupTimeoutMs,
      })
      if (started.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] apple-container start failed for ${id}: ${errorText(started)}`
        )
      }
    } catch (error) {
      await runAppleContainerCli({
        argv: buildDeleteArgv(options.cli, id),
        cwd: process.cwd(),
        env: hostEnv(),
        timeoutMs: setupTimeoutMs,
      }).catch(() => {})
      if (networkCreated && network.ownedNetworkName !== undefined) {
        await runAppleContainerCli({
          argv: buildNetworkDeleteArgv(options.cli.bin, network.ownedNetworkName),
          cwd: process.cwd(),
          env: hostEnv(),
          timeoutMs: setupTimeoutMs,
        }).catch(() => {})
      }
      throw error
    }

    return new AppleContainerSandbox({
      id,
      cli: options.cli,
      workingDirectory,
      env: options.env ?? {},
      timeout: options.timeout,
      network,
      setupTimeoutMs,
    })
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.assertRunning("run commands")

    const { controller, cleanup } = this.commandController(options.signal)
    try {
      return await runAppleContainerCli({
        argv: buildExecArgv(this.cli, {
          id: this.id,
          cwd: options.cwd ?? this.workingDirectory,
          command,
          args,
          env: { ...this.sandboxEnv, ...(options.env ?? {}) },
        }),
        cwd: process.cwd(),
        env: hostEnv(),
        timeoutMs: options.timeout ?? this.defaultTimeoutMs,
        signal: controller.signal,
      })
    } finally {
      cleanup()
      this.inFlight.delete(controller)
    }
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    this.assertRunning("write files")
    if (files.length === 0) {
      return
    }
    for (const file of files) {
      const target = this.resolveWithinWorkingDirectory(file.path)
      const mode = file.mode === undefined ? "" : file.mode.toString(8)
      const result = await runAppleContainerCli({
        argv: buildExecArgv(this.cli, {
          id: this.id,
          cwd: "/",
          command: "/bin/sh",
          args: ["-c", WRITE_FILE_SCRIPT, "sh", target, mode],
          env: {},
          interactive: true,
        }),
        cwd: process.cwd(),
        env: hostEnv(),
        timeoutMs: this.setupTimeoutMs,
        stdin: Buffer.from(file.contents),
      })
      if (result.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] apple-container writeFiles failed for ${this.id}: ${errorText(result)}`
        )
      }
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
    await runAppleContainerCli({
      argv: buildStopArgv(this.cli, this.id),
      cwd: process.cwd(),
      env: hostEnv(),
      timeoutMs: this.setupTimeoutMs,
    }).catch(() => {})
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }
    if (this.currentStatus === "running") {
      await this.stop()
    }

    if (!this.containerDeleted) {
      const deleted = await runAppleContainerCli({
        argv: buildDeleteArgv(this.cli, this.id),
        cwd: process.cwd(),
        env: hostEnv(),
        timeoutMs: this.setupTimeoutMs,
      })
      if (deleted.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] apple-container delete failed for ${this.id}: ${errorText(deleted)}`
        )
      }
      this.containerDeleted = true
    }

    if (!this.networkDeleted && this.network.ownedNetworkName !== undefined) {
      const deletedNetwork = await runAppleContainerCli({
        argv: buildNetworkDeleteArgv(this.cli.bin, this.network.ownedNetworkName),
        cwd: process.cwd(),
        env: hostEnv(),
        timeoutMs: this.setupTimeoutMs,
      })
      if (deletedNetwork.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] apple-container network delete failed for ${this.network.ownedNetworkName}: ${errorText(deletedNetwork)}`
        )
      }
      this.networkDeleted = true
    }

    this.destroyed = true
    this.currentStatus = "stopped"
  }

  private assertRunning(action: string): void {
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${this.currentStatus}; cannot ${action}`
      )
    }
  }

  private commandController(userSignal: AbortSignal | undefined): {
    readonly controller: AbortController
    cleanup(): void
  } {
    const controller = new AbortController()
    const onUserAbort = (): void => controller.abort()
    userSignal?.addEventListener("abort", onUserAbort)
    if (userSignal?.aborted) {
      onUserAbort()
    }
    this.inFlight.add(controller)
    return {
      controller,
      cleanup: () => userSignal?.removeEventListener("abort", onUserAbort),
    }
  }

  private resolveWithinWorkingDirectory(path: string): string {
    const target = posix.resolve(this.workingDirectory, path)
    if (target !== this.workingDirectory && !target.startsWith(`${this.workingDirectory}/`)) {
      throw new Error(
        `[Sandbox] writeFiles path '${path}' escapes the sandbox working directory ${this.workingDirectory}`
      )
    }
    return target
  }
}

function normalizeWorkingDirectory(value: string | undefined): string {
  return value && value.length > 0
    ? posix.resolve("/", value)
    : posix.resolve("/", DEFAULT_WORKING_DIRECTORY)
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

function errorText(result: { readonly stderr: string; readonly exitCode: number }): string {
  return result.stderr.trim() || `exit ${result.exitCode}`
}
