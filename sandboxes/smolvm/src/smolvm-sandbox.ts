import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import {
  type CommandResult,
  type CreateSandboxOptions,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  type SandboxNetworkPolicy,
  SandboxNotRunningError,
  type SandboxStatus,
} from "@sixb/core"
import { exec } from "@sixb/core/sandboxes"
import {
  buildCreateArgv,
  buildExecArgv,
  buildRemoveArgv,
  buildStartArgv,
  buildStopArgv,
  isLocalImageArchive,
  type SmolvmCliConfig,
} from "./cli"
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
        argv: buildCreateArgv(options.cli, { id, network }),
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

      // The guest filesystem is isolated (no host mount), so create the working directory in-guest
      // up front. This keeps workingDirectory a valid `--workdir` for the first runCommand even when
      // no files are materialized first. Run from "/" since workdir.dir does not exist yet.
      const workdirReady = await exec({
        argv: buildExecArgv(options.cli, {
          id,
          cwd: "/",
          command: "mkdir",
          args: ["-p", workdir.dir],
          env: {},
        }),
        cwd: workdir.dir,
        env: hostEnv(),
      })
      if (workdirReady.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] smolvm working directory setup failed for ${id}: ${workdirReady.stderr.trim() || `exit ${workdirReady.exitCode}`}`
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

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${this.currentStatus}; cannot write files`
      )
    }
    if (files.length === 0) {
      return
    }
    // The guest filesystem is isolated from the host, so materialize files by executing an in-guest
    // script that base64-decodes each payload into place. Run from "/" (always present) because a
    // target directory may not exist yet; the script mkdir -p's each one.
    const result = await exec({
      argv: buildExecArgv(this.cli, {
        id: this.id,
        cwd: "/",
        command: "sh",
        args: ["-c", buildWriteFilesScript(files)],
        env: {},
      }),
      cwd: this.workdir.dir,
      env: hostEnv(),
    })
    if (result.exitCode !== 0) {
      throw new SandboxError(
        `[Sandbox] smolvm writeFiles failed for ${this.id}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
      )
    }
  }

  // A per-command exec (runCommand) that times out or is aborted only SIGKILLs the host smolvm
  // CLI process; a runaway guest process can outlive its exec session. stop()/destroy() reap the
  // whole VM, so they are the backstop that guarantees no guest work survives teardown.
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

/**
 * A microVM has its own network stack, so a gateway advertised on localhost is unreachable from
 * inside it under restricted egress. Warn on every affected sandbox with the fix rather than letting
 * the agent fail silently with connection-refused. (Per-sandbox on purpose: a module-level once-flag
 * would silence every sandbox after the first and leak state across tests.)
 */
function warnIfLoopbackGateway(policy: SandboxNetworkPolicy): void {
  if (policy.mode !== "restricted") {
    return
  }
  const loopback = policy.allow.find((target) => isLoopbackOrigin(target.origin))
  if (loopback) {
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

/**
 * Build a POSIX `sh` script that materializes each file in-guest: create its parent directory, then
 * base64-decode the payload into place (base64 keeps binary/quoting safe), honoring an optional
 * mode. `set -e` aborts on the first failure so a partial write surfaces a non-zero exit.
 */
export function buildWriteFilesScript(files: readonly SandboxFileRecord[]): string {
  const lines = ["set -e"]
  for (const file of files) {
    const encoded = Buffer.from(file.contents).toString("base64")
    const quotedPath = shellQuote(file.path)
    lines.push(`mkdir -p ${shellQuote(dirname(file.path))}`)
    lines.push(`printf %s ${shellQuote(encoded)} | base64 -d > ${quotedPath}`)
    if (file.mode !== undefined) {
      lines.push(`chmod ${file.mode.toString(8)} ${quotedPath}`)
    }
  }
  return lines.join("\n")
}

/** Single-quote a value for safe interpolation into a POSIX shell script. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
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
