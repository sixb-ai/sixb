import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CommandResult,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  type SandboxNetworkPolicy,
  SandboxNotRunningError,
  type SandboxRequestCredential,
  type SandboxSessionOptions,
  type SandboxStatus,
} from "@sixb/core"
import {
  cappedCommandTimeout,
  exec,
  GUEST_COMMAND_UID,
  GUEST_CREDENTIALS_ENV,
  GUEST_FORWARDER_NOT_RUNNING,
  type GuestCommand,
  guestCredentialedUrl,
  guestCredentialsCommands,
  MAX_TIMER_DELAY_MS,
  unprivilegedGuestArgv,
} from "@sixb/core/sandboxes"
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

export interface SmolvmSandboxOptions extends SandboxSessionOptions {
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

/**
 * The guest filesystem is isolated from the host, so the working directory is a guest path, like
 * Apple Container and Azure. Images that run as a non-root user must provide it writable.
 */
const DEFAULT_WORKING_DIRECTORY = "/workspace"

export class SmolvmSandbox implements Sandbox {
  readonly id: string
  readonly provider = "smolvm"
  /** Commands are timed with a timer, which holds no longer delay. */
  readonly maxCommandTimeout = MAX_TIMER_DELAY_MS
  readonly workingDirectory: string

  private currentStatus: SandboxStatus = "running"
  private readonly cli: SmolvmCliConfig
  private readonly sandboxEnv: Readonly<Record<string, string>>
  private readonly defaultTimeoutMs: number | undefined
  private readonly inFlight = new Set<AbortController>()

  private constructor(input: {
    readonly id: string
    readonly workingDirectory: string
    readonly cli: SmolvmCliConfig
    readonly env: Readonly<Record<string, string>>
    readonly timeout: number | undefined
  }) {
    this.id = input.id
    this.workingDirectory = input.workingDirectory
    this.cli = input.cli
    this.sandboxEnv = input.env
    this.defaultTimeoutMs = input.timeout
  }

  get status(): SandboxStatus {
    return this.currentStatus
  }

  static async create(options: SmolvmSandboxOptions): Promise<SmolvmSandbox> {
    const id = options.id ?? randomUUID()
    const workingDirectory = posix.resolve(
      "/",
      options.workingDirectory || DEFAULT_WORKING_DIRECTORY
    )
    // A registry image pulls at start, so it needs the registry on the allow
    // list. A local image archive and a bare machine both boot offline, so they
    // stay locked to the given policy (no registry egress).
    const basePolicy = options.network ?? { mode: "none" }
    warnIfLoopbackApi(basePolicy)
    const needsRegistry = options.cli.image !== undefined && !isLocalImageArchive(options.cli.image)
    const policy = needsRegistry
      ? withRegistryEgress(basePolicy, options.registryHosts ?? [])
      : basePolicy
    const network = buildNetworkFlags(policy)

    try {
      const created = await exec({
        argv: buildCreateArgv(options.cli, { id, network }),
        cwd: process.cwd(),
        env: hostEnv(),
      })
      if (created.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] smolvm create failed for ${id}: ${created.stderr.trim() || `exit ${created.exitCode}`}`
        )
      }

      const started = await exec({
        argv: buildStartArgv(options.cli, id),
        cwd: process.cwd(),
        env: hostEnv(),
      })
      if (started.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] smolvm start failed for ${id}: ${started.stderr.trim() || `exit ${started.exitCode}`}`
        )
      }

      // Create the working directory in-guest up front, so it is a valid `--workdir` for the first
      // runCommand even when no files are materialized first. Run from "/" since it may not exist.
      // Commands run as an unprivileged user (see runCommand): the directory is theirs.
      const workdirReady = await exec({
        argv: buildExecArgv(options.cli, {
          id,
          cwd: "/",
          command: "sh",
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
      })
      if (workdirReady.exitCode !== 0) {
        throw new SandboxError(
          `[Sandbox] smolvm working directory setup failed for ${id}: ${workdirReady.stderr.trim() || `exit ${workdirReady.exitCode}`}`
        )
      }
      if (options.requestCredentials?.length) {
        await installGuestCredentials(options.cli, id, options.requestCredentials)
      }
    } catch (error) {
      // Best-effort cleanup of a half-created machine.
      await exec({ argv: buildRemoveArgv(options.cli, id), cwd: process.cwd(), env: hostEnv() })
      throw error
    }

    return new SmolvmSandbox({
      id,
      workingDirectory,
      cli: options.cli,
      env: options.env ?? {},
      timeout: options.timeout,
    })
  }

  /** Replace the credentials the guest's forwarder adds; see {@link credentialedUrl}. */
  readonly setRequestCredentials = async (
    credentials: readonly SandboxRequestCredential[]
  ): Promise<void> => {
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${this.currentStatus}; cannot update request credentials`
      )
    }
    await installGuestCredentials(this.cli, this.id, credentials)
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
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${this.currentStatus}; cannot run commands`
      )
    }

    const env = { ...this.sandboxEnv, ...(options.env ?? {}) }
    const cwd = posix.resolve(this.workingDirectory, options.cwd ?? ".")
    const timeoutMs = cappedCommandTimeout(
      options.timeout ?? this.defaultTimeoutMs,
      this.maxCommandTimeout
    )

    const controller = new AbortController()
    const onUserAbort = (): void => controller.abort()
    options.signal?.addEventListener("abort", onUserAbort)
    if (options.signal?.aborted) {
      onUserAbort()
    }
    this.inFlight.add(controller)

    try {
      const [unprivileged = command, ...unprivilegedArgs] = unprivilegedGuestArgv(command, args)
      return await exec({
        argv: buildExecArgv(this.cli, {
          id: this.id,
          cwd,
          command: unprivileged,
          args: unprivilegedArgs,
          env,
        }),
        cwd: process.cwd(),
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
    // The guest filesystem is isolated from the host, so files are materialized by an in-guest
    // script that reads them from its input. Never from its arguments: Linux caps one at 128 KiB,
    // less than the `sixb` a run installs. Run from "/" (always present) because a target directory
    // may not exist yet; the script creates each one. That is why relative paths are resolved
    // against workingDirectory here rather than by the guest shell.
    // As the command user, like the commands: a link a command planted can't lead a write, with
    // root's rights, anywhere the command couldn't write itself.
    const [command = "sh", ...args] = unprivilegedGuestArgv("sh", ["-c", WRITE_FILES_SCRIPT])
    const result = await exec({
      argv: buildExecArgv(this.cli, {
        id: this.id,
        cwd: "/",
        command,
        args,
        env: {},
        interactive: true,
      }),
      cwd: process.cwd(),
      env: hostEnv(),
      stdin: buildWriteFilesInput(
        files.map((file) => ({ ...file, path: posix.resolve(this.workingDirectory, file.path) }))
      ),
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
    await exec({ argv: buildStopArgv(this.cli, this.id), cwd: process.cwd(), env: hostEnv() })
  }

  async destroy(): Promise<void> {
    if (this.currentStatus === "running") {
      await this.stop()
    }
    await exec({ argv: buildRemoveArgv(this.cli, this.id), cwd: process.cwd(), env: hostEnv() })
  }
}

/**
 * A microVM has its own network stack, so a Sixb API advertised on localhost is unreachable from
 * inside it under restricted egress. Warn on every affected sandbox with the fix rather than letting
 * the agent fail silently with connection-refused. (Per-sandbox on purpose: a module-level once-flag
 * would silence every sandbox after the first and leak state across tests.)
 */
function warnIfLoopbackApi(policy: SandboxNetworkPolicy): void {
  if (policy.mode !== "restricted") {
    return
  }
  const loopback = policy.allow.find((target) => isLoopbackOrigin(target.origin))
  if (loopback) {
    console.warn(
      `[Sandbox] smolvm runs in a VM and cannot reach the Sixb API at ${loopback.origin} over localhost. ` +
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
 * A POSIX `sh` script that materializes the files {@link buildWriteFilesInput} streams to it:
 * create each file's parent directory, copy its bytes into place, then apply its mode. Lengths,
 * not delimiters, frame each path and payload, so any byte survives. `dd` copies exact counts:
 * `fullblock` keeps a short read from the pipe from counting as a whole block, and it copies 64 KiB
 * at a time rather than holding a whole file. `set -e` aborts on the first failure, and an input
 * that ends before its `end` line fails rather than leave a truncated file behind.
 */
export const WRITE_FILES_SCRIPT = `set -e
take() {
  blocks=$(($1 / 65536))
  rest=$(($1 % 65536))
  if [ "$blocks" -gt 0 ]; then dd bs=65536 count="$blocks" iflag=fullblock status=none; fi
  if [ "$rest" -gt 0 ]; then dd bs="$rest" count=1 iflag=fullblock status=none; fi
}
while read -r path_bytes size mode; do
  if [ "$path_bytes" = end ]; then
    exit 0
  fi
  path=$(take "$path_bytes"; echo .)
  path=\${path%.}
  directory=\${path%/*}/
  if [ ! -d "$directory" ]; then
    mkdir -p "$directory"
  fi
  take "$size" > "$path"
  if [ "$mode" != - ]; then
    chmod "$mode" "$path"
  fi
done
echo "the files' input ended early" >&2
exit 1`

/**
 * The input of {@link WRITE_FILES_SCRIPT}. For each file, a line with the byte lengths of its path
 * and contents and its octal mode (`-` when unset), then the path, then the contents. An `end`
 * line closes it.
 */
export function buildWriteFilesInput(files: readonly SandboxFileRecord[]): Blob {
  const parts: BlobPart[] = []
  for (const file of files) {
    const path = new Blob([file.path])
    const contents = new Blob([Buffer.from(file.contents)])
    const mode = file.mode === undefined ? "-" : file.mode.toString(8)
    parts.push(`${path.size} ${contents.size} ${mode}\n`, path, contents)
  }
  parts.push("end\n")
  return new Blob(parts)
}

/** Install the credentials in the guest and start its forwarder, as root. */
async function installGuestCredentials(
  cli: SmolvmCliConfig,
  id: string,
  credentials: readonly SandboxRequestCredential[]
): Promise<void> {
  const { install, start, ready } = guestCredentialsCommands(credentials)
  const installed = await rootExec(cli, id, install)
  if (installed.exitCode === 3) {
    throw new SandboxError(
      `[Sandbox] smolvm request credentials need Bun or Node in the image of ${id}.`
    )
  }
  // Never the output: a failed step must not echo what it was given.
  const failed = () =>
    new SandboxError(`[Sandbox] smolvm could not install request credentials in ${id}.`)
  if (installed.exitCode === GUEST_FORWARDER_NOT_RUNNING) {
    if ((await rootExec(cli, id, start, { detach: true })).exitCode !== 0) throw failed()
  } else if (installed.exitCode !== 0) {
    throw failed()
  }
  if ((await rootExec(cli, id, ready)).exitCode !== 0) throw failed()
}

/**
 * Run a guest command as root. The credentials travel in the smolvm process's own environment
 * (`--secret-env`), never in its arguments, which other users of the host could read.
 */
function rootExec(
  cli: SmolvmCliConfig,
  id: string,
  command: GuestCommand,
  options: { readonly detach?: boolean } = {}
): Promise<CommandResult> {
  const { [GUEST_CREDENTIALS_ENV]: secret, ...env } = command.env
  const [program = "sh", ...args] = command.argv
  return exec({
    argv: buildExecArgv(cli, {
      id,
      cwd: "/",
      command: program,
      args,
      env,
      ...(secret === undefined ? {} : { secretEnv: [GUEST_CREDENTIALS_ENV] }),
      ...(options.detach ? { detach: true } : {}),
    }),
    cwd: process.cwd(),
    env: { ...hostEnv(), ...(secret === undefined ? {} : { [GUEST_CREDENTIALS_ENV]: secret }) },
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
