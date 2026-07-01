import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type CommandResult,
  type CreateSandboxOptions,
  exec,
  type RunCommandOptions,
  type Sandbox,
  type SandboxFileRecord,
  SandboxIsolationUnavailableError,
  type SandboxNetworkPolicy,
  SandboxNotRunningError,
  type SandboxStatus,
} from "@sixb/core"
import { buildBwrapArgv } from "./isolation/bwrap"
import {
  detectIsolation,
  type IsolationProbe,
  type LocalIsolation,
  type ResolvedIsolation,
} from "./isolation/detect"
import { warnIfRestrictedDowngraded } from "./isolation/network"
import { buildNoneArgv } from "./isolation/none"
import { buildSeatbeltArgv, buildSeatbeltProfile } from "./isolation/seatbelt"

export interface LocalSandboxOptions extends CreateSandboxOptions {
  readonly id?: string
  readonly isolation?: LocalIsolation
  readonly readOnlyPaths?: readonly string[]
  readonly readWritePaths?: readonly string[]
}

const HOST_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TMPDIR"] as const

export class LocalSandbox implements Sandbox {
  readonly id: string
  readonly provider = "local"
  readonly workingDirectory: string

  private currentStatus: SandboxStatus
  private readonly backend: ResolvedIsolation
  private readonly sandboxEnv: Readonly<Record<string, string>>
  private readonly defaultTimeoutMs: number | undefined
  private readonly network: SandboxNetworkPolicy
  private readonly readOnlyPaths: readonly string[]
  private readonly readWritePaths: readonly string[]
  private readonly inFlight = new Set<AbortController>()
  private readonly cleanupWorkingDirectory: boolean

  private constructor(input: {
    readonly id: string
    readonly workingDirectory: string
    readonly backend: ResolvedIsolation
    readonly env: Readonly<Record<string, string>>
    readonly timeout: number | undefined
    readonly network: SandboxNetworkPolicy
    readonly readOnlyPaths: readonly string[]
    readonly readWritePaths: readonly string[]
    readonly cleanupWorkingDirectory: boolean
  }) {
    this.id = input.id
    this.workingDirectory = input.workingDirectory
    this.backend = input.backend
    this.sandboxEnv = input.env
    this.defaultTimeoutMs = input.timeout
    this.network = input.network
    this.readOnlyPaths = input.readOnlyPaths
    this.readWritePaths = input.readWritePaths
    this.cleanupWorkingDirectory = input.cleanupWorkingDirectory
    this.currentStatus = "running"
  }

  get status(): SandboxStatus {
    return this.currentStatus
  }

  static detectIsolation(): IsolationProbe {
    return detectIsolation()
  }

  static async create(options: LocalSandboxOptions = {}): Promise<LocalSandbox> {
    const requested = options.isolation ?? "auto"
    const backend = await resolveBackend(requested)

    const id = options.id ?? randomUUID()
    const { workingDirectory, generated } = await resolveWorkingDirectory(
      options.workingDirectory,
      id
    )

    // No local backend can enforce a per-origin allow list, so a restricted policy degrades to host
    // network. Warn once here (rather than per backend) so the degradation is never silent.
    const network = options.network ?? { mode: "none" }
    warnIfRestrictedDowngraded(network)

    return new LocalSandbox({
      id,
      workingDirectory,
      backend,
      env: options.env ?? {},
      timeout: options.timeout,
      network,
      readOnlyPaths: options.readOnlyPaths ?? [],
      readWritePaths: options.readWritePaths ?? [],
      cleanupWorkingDirectory: generated,
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

    const argv = this.buildArgv(command, args)
    const env = this.mergeEnv(options.env)
    const cwd = options.cwd ?? this.workingDirectory
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
        argv,
        cwd,
        env,
        timeoutMs,
        signal: controller.signal,
      })
    } finally {
      this.inFlight.delete(controller)
      options.signal?.removeEventListener("abort", onUserAbort)
    }
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${this.currentStatus}; cannot write files`
      )
    }
    // Local sandboxes execute on the host filesystem, so materializing files is a direct write.
    // Paths live under workingDirectory, which the isolation profiles already allow writing to.
    for (const file of files) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.contents)
      if (file.mode !== undefined) {
        await chmod(file.path, file.mode)
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
  }

  async destroy(): Promise<void> {
    if (this.currentStatus === "running") {
      await this.stop()
    }
    if (this.cleanupWorkingDirectory) {
      await rm(this.workingDirectory, { recursive: true, force: true })
    }
  }

  private buildArgv(command: string, args: readonly string[]): readonly string[] {
    if (this.backend === "none") {
      return buildNoneArgv({ command, args })
    }
    if (this.backend === "bwrap") {
      return buildBwrapArgv({
        command,
        args,
        workingDirectory: this.workingDirectory,
        readOnlyPaths: this.readOnlyPaths,
        readWritePaths: this.readWritePaths,
        network: this.network,
      })
    }
    if (this.backend === "seatbelt") {
      const profile = buildSeatbeltProfile({
        workingDirectory: this.workingDirectory,
        readOnlyPaths: this.readOnlyPaths,
        readWritePaths: this.readWritePaths,
        network: this.network,
      })
      return buildSeatbeltArgv({ profile, command, args })
    }
    throw new SandboxIsolationUnavailableError(
      `[Sandbox] isolation backend '${this.backend}' is not implemented`
    )
  }

  private mergeEnv(perCall: RunCommandOptions["env"]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const key of HOST_ENV_ALLOWLIST) {
      const value = process.env[key]
      if (value !== undefined) out[key] = value
    }
    Object.assign(out, this.sandboxEnv)
    if (perCall) {
      Object.assign(out, perCall)
    }
    return out
  }
}

async function resolveBackend(requested: LocalIsolation): Promise<ResolvedIsolation> {
  const probe = detectIsolation()

  if (requested === "auto") {
    return probe.backend
  }

  if (requested === "none") {
    return "none"
  }

  if (requested === probe.backend) {
    return requested
  }

  throw new SandboxIsolationUnavailableError(
    `[Sandbox] isolation '${requested}' is not available on this host (${probe.message})`
  )
}

async function resolveWorkingDirectory(
  configured: string | undefined,
  id: string
): Promise<{ readonly workingDirectory: string; readonly generated: boolean }> {
  if (configured) {
    await mkdir(configured, { recursive: true })
    return { workingDirectory: await realpath(configured), generated: false }
  }
  const dir = await mkdtemp(join(tmpdir(), `sixb-sandbox-${id}-`))
  return { workingDirectory: await realpath(dir), generated: true }
}
