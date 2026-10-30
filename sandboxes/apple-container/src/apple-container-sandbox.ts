import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CommandResult,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  SandboxNotRunningError,
  type SandboxRequestCredential,
  type SandboxSessionOptions,
  type SandboxStatus,
} from "@sixb/core"
import {
  GUEST_COMMAND_UID,
  GUEST_CREDENTIALS_ENV,
  GUEST_FORWARDER_NOT_RUNNING,
  type GuestCommand,
  guestCredentialedUrl,
  guestCredentialsCommands,
  unprivilegedGuestArgv,
} from "@sixb/core/sandboxes"
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

export interface AppleContainerSandboxOptions extends SandboxSessionOptions {
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
// Written as root, then owned by the user commands run as: the file and each directory it created
// inside the working directory, the remaining arguments.
const WRITE_FILE_SCRIPT = `mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && if [ -n "$2" ]; then chmod "$2" "$1"; fi && shift 2 && chown ${GUEST_COMMAND_UID}:${GUEST_COMMAND_UID} -- "$@"`

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

      // Commands run as an unprivileged user (see runCommand): the directory is theirs.
      const owned = await runAppleContainerCli({
        argv: buildExecArgv(options.cli, {
          id,
          cwd: "/",
          command: "/bin/sh",
          args: [
            "-c",
            `mkdir -p "$1" && chown ${GUEST_COMMAND_UID}:${GUEST_COMMAND_UID} "$1"`,
            "sh",
            workingDirectory,
          ],
          env: {},
        }),
        cwd: process.cwd(),
        env: hostEnv(),
        timeoutMs: setupTimeoutMs,
      })
      if (owned.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] apple-container working directory setup failed for ${id}: ${errorText(owned)}`
        )
      }
      if (options.requestCredentials?.length) {
        await installGuestCredentials(options.cli, id, setupTimeoutMs, options.requestCredentials)
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

  /** Replace the credentials the guest's forwarder adds; see {@link credentialedUrl}. */
  readonly setRequestCredentials = async (
    credentials: readonly SandboxRequestCredential[]
  ): Promise<void> => {
    this.assertRunning("update request credentials")
    await installGuestCredentials(this.cli, this.id, this.setupTimeoutMs, credentials)
  }

  /**
   * A socket in the guest that forwards to `url` with the matching credential. A root forwarder
   * holds the credentials; commands run unprivileged and cannot read them.
   */
  readonly credentialedUrl = (url: string): string => guestCredentialedUrl(url)

  /** Every command runs as an unprivileged user, so it cannot read what the guest's root holds. */
  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.assertRunning("run commands")

    const { controller, cleanup } = this.commandController(options.signal)
    const [unprivileged = command, ...unprivilegedArgs] = unprivilegedGuestArgv(command, args)
    try {
      return await runAppleContainerCli({
        argv: buildExecArgv(this.cli, {
          id: this.id,
          cwd: posix.resolve(this.workingDirectory, options.cwd ?? "."),
          command: unprivileged,
          args: unprivilegedArgs,
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
      const owned: string[] = []
      for (
        let path = target;
        path.startsWith(`${this.workingDirectory}/`);
        path = posix.dirname(path)
      ) {
        owned.push(path)
      }
      const result = await runAppleContainerCli({
        argv: buildExecArgv(this.cli, {
          id: this.id,
          cwd: "/",
          command: "/bin/sh",
          args: ["-c", WRITE_FILE_SCRIPT, "sh", target, mode, ...owned],
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

/** Install the credentials in the guest and start its forwarder, as root. */
async function installGuestCredentials(
  cli: AppleContainerCliConfig,
  id: string,
  timeoutMs: number,
  credentials: readonly SandboxRequestCredential[]
): Promise<void> {
  const { install, start, ready } = guestCredentialsCommands(credentials)
  const installed = await rootExec(cli, id, timeoutMs, install)
  if (installed.exitCode === 3) {
    throw new SandboxError(
      `[Sandbox] apple-container request credentials need Bun or Node in the image of ${id}.`
    )
  }
  // Never the output: a failed step must not echo what it was given.
  const failed = () =>
    new SandboxError(`[Sandbox] apple-container could not install request credentials in ${id}.`)
  if (installed.exitCode === GUEST_FORWARDER_NOT_RUNNING) {
    if ((await rootExec(cli, id, timeoutMs, start, { detach: true })).exitCode !== 0) {
      throw failed()
    }
  } else if (installed.exitCode !== 0) {
    throw failed()
  }
  if ((await rootExec(cli, id, timeoutMs, ready)).exitCode !== 0) throw failed()
}

/**
 * Run a guest command as root. The credentials travel in the container CLI's own environment
 * (`--env KEY`), never in its arguments, which other users of the host could read.
 */
function rootExec(
  cli: AppleContainerCliConfig,
  id: string,
  timeoutMs: number,
  command: GuestCommand,
  options: { readonly detach?: boolean } = {}
): Promise<CommandResult> {
  const { [GUEST_CREDENTIALS_ENV]: secret, ...env } = command.env
  const [program = "/bin/sh", ...args] = command.argv
  return runAppleContainerCli({
    argv: buildExecArgv(cli, {
      id,
      cwd: "/",
      command: program,
      args,
      env,
      ...(secret === undefined ? {} : { inheritedEnv: [GUEST_CREDENTIALS_ENV] }),
      ...(options.detach ? { detach: true } : {}),
    }),
    cwd: process.cwd(),
    env: { ...hostEnv(), ...(secret === undefined ? {} : { [GUEST_CREDENTIALS_ENV]: secret }) },
    timeoutMs,
  })
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
