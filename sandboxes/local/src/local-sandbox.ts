import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import {
  type CommandResult,
  type RunCommandOptions,
  type Sandbox,
  type SandboxFileRecord,
  SandboxIsolationUnavailableError,
  type SandboxNetworkPolicy,
  SandboxNotRunningError,
  type SandboxRequestCredential,
  type SandboxSessionOptions,
  type SandboxStatus,
} from "@sixb/core"
import { exec } from "@sixb/core/sandboxes"
import { CredentialForwarder } from "./credential-forwarder"
import { buildBwrapArgv, type DeniedPath } from "./isolation/bwrap"
import {
  detectIsolation,
  type IsolationProbe,
  type LocalIsolation,
  type ResolvedIsolation,
  warnIfUnisolated,
} from "./isolation/detect"
import { warnIfRestrictedDowngraded } from "./isolation/network"
import { buildNoneArgv } from "./isolation/none"
import { buildSeatbeltArgv, buildSeatbeltProfile } from "./isolation/seatbelt"

export interface LocalSandboxOptions extends SandboxSessionOptions {
  readonly id?: string
  readonly isolation?: LocalIsolation
  readonly readOnlyPaths?: readonly string[]
  readonly readWritePaths?: readonly string[]
  /**
   * Paths commands may neither read nor change, such as a project's `.env` or its database. Needs
   * an isolation backend: creation fails without one.
   */
  readonly denyReadPaths?: readonly string[]
}

const HOST_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TMPDIR"] as const

/** A denied path as the OS sandbox sees it; one that did not exist at creation has no kind. */
type ResolvedDeniedPath = Pick<DeniedPath, "path"> & Partial<Pick<DeniedPath, "kind">>

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
  private readonly denyReadPaths: readonly ResolvedDeniedPath[]
  private readonly inFlight = new Set<AbortController>()
  private readonly cleanupWorkingDirectory: boolean
  private readonly forwarder: CredentialForwarder

  private constructor(input: {
    readonly id: string
    readonly workingDirectory: string
    readonly backend: ResolvedIsolation
    readonly env: Readonly<Record<string, string>>
    readonly timeout: number | undefined
    readonly network: SandboxNetworkPolicy
    readonly readOnlyPaths: readonly string[]
    readonly readWritePaths: readonly string[]
    readonly denyReadPaths: readonly ResolvedDeniedPath[]
    readonly cleanupWorkingDirectory: boolean
    readonly forwarder: CredentialForwarder
  }) {
    this.id = input.id
    this.workingDirectory = input.workingDirectory
    this.backend = input.backend
    this.sandboxEnv = input.env
    this.defaultTimeoutMs = input.timeout
    this.network = input.network
    this.readOnlyPaths = input.readOnlyPaths
    this.readWritePaths = input.readWritePaths
    this.denyReadPaths = input.denyReadPaths
    this.cleanupWorkingDirectory = input.cleanupWorkingDirectory
    this.forwarder = input.forwarder
    this.currentStatus = "running"
  }

  /** Replace every credential the forwarder adds; see {@link credentialedUrl}. */
  readonly setRequestCredentials = async (
    credentials: readonly SandboxRequestCredential[]
  ): Promise<void> => {
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${this.currentStatus}; cannot update request credentials`
      )
    }
    this.forwarder.setCredentials(credentials)
  }

  /**
   * A `unix:` socket that forwards to `url` with the matching credential added by this process,
   * so commands reach `url` without ever holding the credential.
   */
  readonly credentialedUrl = (url: string): string => this.forwarder.urlFor(url)

  get status(): SandboxStatus {
    return this.currentStatus
  }

  static detectIsolation(): IsolationProbe {
    return detectIsolation()
  }

  static async create(options: LocalSandboxOptions = {}): Promise<LocalSandbox> {
    const requested = options.isolation ?? "auto"
    const backend = await resolveBackend(requested)
    const denyReadPaths = await resolveDeniedPaths(options.denyReadPaths ?? [])
    if (denyReadPaths.length > 0 && backend === "none") {
      throw new SandboxIsolationUnavailableError(
        "[Sandbox] denyReadPaths needs an isolation backend, and none is in use: install the backend for this platform, or drop denyReadPaths."
      )
    }

    const id = options.id ?? randomUUID()
    const { workingDirectory, generated } = await resolveWorkingDirectory(
      options.workingDirectory,
      id
    )

    // No local backend can enforce a per-origin allow list, so a restricted policy degrades to host
    // network. Warn once here (rather than per backend) so the degradation is never silent.
    const network = options.network ?? { mode: "none" }
    warnIfRestrictedDowngraded(network)

    const forwarder = await CredentialForwarder.start()
    try {
      forwarder.setCredentials(options.requestCredentials ?? [])
    } catch (error) {
      await forwarder.stop()
      throw error
    }

    return new LocalSandbox({
      id,
      workingDirectory,
      backend,
      env: options.env ?? {},
      timeout: options.timeout,
      network,
      readOnlyPaths: options.readOnlyPaths ?? [],
      readWritePaths: options.readWritePaths ?? [],
      denyReadPaths,
      cleanupWorkingDirectory: generated,
      forwarder,
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
    const cwd = resolve(this.workingDirectory, options.cwd ?? ".")
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
    // Local sandboxes write straight to the host filesystem — there is no guest boundary — so every
    // path is confined to workingDirectory before writing. Without this an absolute path would escape
    // onto the host. smolvm needs no such check: its writes land inside the VM.
    for (const file of files) {
      const target = this.resolveWithinWorkingDirectory(file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.contents)
      if (file.mode !== undefined) {
        await chmod(target, file.mode)
      }
    }
  }

  private resolveWithinWorkingDirectory(path: string): string {
    const target = resolve(this.workingDirectory, path)
    if (target !== this.workingDirectory && !target.startsWith(this.workingDirectory + sep)) {
      throw new Error(
        `[Sandbox] writeFiles path '${path}' escapes the sandbox working directory ${this.workingDirectory}`
      )
    }
    return target
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
    await this.forwarder.stop()
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
        // A path missing when the sandbox was created has nothing to mount over.
        denyReadPaths: this.denyReadPaths.filter(
          (path): path is DeniedPath => path.kind !== undefined
        ),
        network: this.network,
      })
    }
    if (this.backend === "seatbelt") {
      const profile = buildSeatbeltProfile({
        workingDirectory: this.workingDirectory,
        readOnlyPaths: this.readOnlyPaths,
        readWritePaths: this.readWritePaths,
        denyReadPaths: this.denyReadPaths.map(({ path }) => path),
        network: this.network,
        forwarderDirectory: this.forwarder.directory,
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
    warnIfUnisolated(probe)
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

/**
 * Each denied path as the OS sandbox sees it: absolute, its links followed, and what it is. One that
 * does not exist yet is named under its parent's real path, as macOS reports it once created.
 */
async function resolveDeniedPaths(
  paths: readonly string[]
): Promise<readonly ResolvedDeniedPath[]> {
  return Promise.all(
    paths.map(async (path): Promise<ResolvedDeniedPath> => {
      const absolute = resolve(path)
      const real = await realpath(absolute).catch(() => undefined)
      if (real) return { path: real, kind: (await stat(real)).isDirectory() ? "directory" : "file" }

      const parent = await realpath(dirname(absolute)).catch(() => dirname(absolute))
      return { path: join(parent, basename(absolute)) }
    })
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
