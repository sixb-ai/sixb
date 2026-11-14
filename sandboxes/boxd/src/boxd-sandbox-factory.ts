import { createHash, randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CreateSandboxOptions,
  initializeSandboxEnvironment,
  type ParamsConfig,
  type ResumeSandboxOptions,
  type Sandbox,
  type SandboxConfig,
  SandboxError,
  type SandboxFactory,
  type SandboxNetworkPolicy,
  type SandboxSessionOptions,
  SandboxStateUnavailableError,
  sandboxConfig,
  sandboxCreationEnvironment,
} from "@sixb/core/sandboxes"
import {
  type BoxdClient,
  type BoxdClientOptions,
  type BoxdMachineRecord,
  createBoxdClient,
  isConflict,
  isNotFound,
} from "./boxd-client"
import { BoxdSandbox, DEFAULT_SETUP_TIMEOUT_MS } from "./boxd-sandbox"
import {
  BOOTSTRAP_NO_SETPRIV,
  BOOTSTRAP_NO_SUDO,
  bootstrapCommand,
  DEFAULT_WORKING_DIRECTORY,
} from "./guest"
import { assertCredentialsAllowed, toBoxdEgress } from "./network"

/** A boxd machine size, `<vCPU>x<GiB of memory>`. */
export type BoxdMachineSize = "1x4" | "2x8" | "4x16" | "8x32"

export interface BoxdSandboxFactoryOptions<in out TParams extends ParamsConfig = ParamsConfig>
  extends SandboxConfig<TParams> {
  /** boxd API key. Defaults to the `BOXD_API_KEY` environment variable. */
  readonly apiKey?: string
  /** The organization the machines belong to. An organization's API key implies its own. */
  readonly org?: string
  /** The region machines are created in, such as `"fra"` or `"nyc"`. Defaults to the API's. */
  readonly region?: string
  /** The boxd API endpoint. Defaults to production. */
  readonly baseURL?: string
  /** Machine size. Defaults to the organization's default size. */
  readonly size?: BoxdMachineSize
  /**
   * A snapshot (name or id) to boot from instead of the default image, for example one with your
   * toolchain installed. It needs `sudo`, `setpriv` and Bun or Node, as the default image has.
   */
  readonly snapshot?: string
  /** Prefix for machine names. Defaults to `"sixb-"`. */
  readonly namePrefix?: string
  /** Labels added to every machine, to find them with `boxd machine list --label`. */
  readonly labels?: Readonly<Record<string, string>>
  /** Default working directory for commands and files. Defaults to `/workspace`. */
  readonly workingDirectory?: string
  /** Default env merged into every sandbox the factory creates. */
  readonly env?: Readonly<Record<string, string>>
  /** Default per-command timeout in milliseconds. */
  readonly timeout?: number
  /** Default network policy. Overridable per create. Defaults to no network. */
  readonly network?: SandboxNetworkPolicy
  /** How long a new or resumed machine may take to accept commands. Defaults to 120 seconds. */
  readonly readyTimeoutMs?: number
  /** Bound for each of the provider's own guest steps, such as installing credentials. */
  readonly setupTimeoutMs?: number
}

const DEFAULT_NAME_PREFIX = "sixb-"
const DEFAULT_READY_TIMEOUT_MS = 120_000
/** The label that holds a persistent sandbox's Sixb name, checked again on resume. */
export const SANDBOX_NAME_LABEL = "sixb-sandbox"
const SIZES: readonly string[] = ["1x4", "2x8", "4x16", "8x32"]

/**
 * Pluggable factory for boxd-backed Sixb sandboxes. Every machine is isolated: it has no peers on
 * its organization's network and no boxd credentials inside it.
 */
export class BoxdSandboxFactory<const TParams extends ParamsConfig = Record<never, never>>
  implements SandboxFactory<TParams>
{
  /** A root forwarder in the guest adds them; commands run as an unprivileged user. */
  readonly supportsRequestCredentials = true
  readonly configuration: SandboxConfig<TParams>
  private client: BoxdClient | undefined
  private readonly readyTimeoutMs: number
  private readonly setupTimeoutMs: number

  constructor(
    private readonly defaults: BoxdSandboxFactoryOptions<TParams> = {},
    private readonly createClient: (options: BoxdClientOptions) => BoxdClient = createBoxdClient
  ) {
    // A run issues credentials for itself; a factory default would outlive every run.
    if ("requestCredentials" in defaults && defaults.requestCredentials !== undefined) {
      throw new SandboxError(
        "[Sandbox] boxd takes request credentials per sandbox, from create() or resume(), never as a factory default."
      )
    }
    if (defaults.size !== undefined && !SIZES.includes(defaults.size)) {
      throw new SandboxError(`[Sandbox] boxd size must be one of ${SIZES.join(", ")}.`)
    }
    const prefix = defaults.namePrefix ?? DEFAULT_NAME_PREFIX
    if (!/^[a-z0-9-]{0,30}$/.test(prefix)) {
      throw new SandboxError(
        "[Sandbox] boxd namePrefix takes at most 30 lowercase letters, digits and hyphens."
      )
    }
    this.readyTimeoutMs = positive(
      defaults.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      "readyTimeoutMs"
    )
    this.setupTimeoutMs = positive(
      defaults.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
      "setupTimeoutMs"
    )
    this.configuration = sandboxConfig<TParams>(defaults)
  }

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const environment = sandboxCreationEnvironment(this.configuration, options)
    const session = this.session(options)
    const persistence = options.persistence
    if (persistence !== undefined) {
      if (
        persistence === null ||
        typeof persistence !== "object" ||
        Object.keys(persistence).some((key) => key !== "name")
      ) {
        throw new SandboxError("[Sandbox] persistence must contain only a sandbox name.")
      }
      assertPersistentName(persistence.name)
    }

    const machineName =
      persistence === undefined
        ? `${this.prefix}${randomUUID().replaceAll("-", "").slice(0, 20)}`
        : persistentMachineName(this.prefix, persistence.name)
    const client = this.boxd()
    let machine: BoxdMachineRecord | undefined
    let sandbox: BoxdSandbox | undefined
    try {
      machine = await client.create({
        name: machineName,
        ...(this.defaults.org === undefined ? {} : { org: this.defaults.org }),
        ...(this.defaults.size === undefined ? {} : { size: this.defaults.size }),
        ...(this.defaults.snapshot === undefined ? {} : { snapshot: this.defaults.snapshot }),
        ...egress(session.network),
        labels: {
          ...this.defaults.labels,
          ...(persistence === undefined ? {} : { [SANDBOX_NAME_LABEL]: persistence.name }),
        },
      })
      await client.waitUntilReady(machine.id, this.readyTimeoutMs)
      options.signal?.throwIfAborted()
      sandbox = this.sandbox(client, machine, session, persistence !== undefined)
      await this.bootstrap(sandbox)
      // Before any setup command, so the source clone already authenticates outside the guest.
      if (session.requestCredentials.length > 0) {
        await sandbox.installCredentials(session.requestCredentials)
      }
      return await initializeSandboxEnvironment(sandbox, environment, options.signal)
    } catch (error) {
      if (persistence !== undefined) {
        // A failed create must never delete a name that another attempt may own: keep it asleep.
        if (machine !== undefined) await client.hibernate(machine.id).catch(() => {})
        throw persistentError(error, "create")
      }
      if (sandbox !== undefined) await sandbox.destroy().catch(() => {})
      else if (machine !== undefined) await client.delete(machine.id).catch(() => {})
      if (error instanceof SandboxError) throw error
      throw new SandboxError(
        `[Sandbox] boxd create failed: ${errorMessage(error)}${this.keyHint()}`
      )
    }
  }

  /**
   * Resume a stopped persistent sandbox: wake its machine and apply this session's network and
   * credentials. Setup never runs again.
   */
  async resume(name: string, options: ResumeSandboxOptions = {}): Promise<Sandbox> {
    if (this.configuration.auth !== undefined && options.requestCredentials === undefined) {
      throw new SandboxError(
        "[Sandbox] Authenticated sandbox configuration requires execution-prepared request credentials on resume."
      )
    }
    const allowed = ["workingDirectory", "env", "timeout", "network", "requestCredentials"]
    if (Object.keys(options).some((key) => !allowed.includes(key))) {
      throw new SandboxError(
        `[Sandbox] resume accepts only session options (${allowed.join(", ")}); pass the existing name separately.`
      )
    }
    assertPersistentName(name)
    const session = this.session(options)
    const client = this.boxd()

    let machine: BoxdMachineRecord
    try {
      machine = await client.get(persistentMachineName(this.prefix, name))
    } catch (error) {
      throw persistentError(error, "resume")
    }
    if (machine.labels?.[SANDBOX_NAME_LABEL] !== name) {
      throw new SandboxStateUnavailableError(
        "[Sandbox] boxd has no saved state for this sandbox name; no replacement was created."
      )
    }
    if (machine.status !== "hibernated" && machine.status !== "stopped") {
      throw new SandboxError(
        "[Sandbox] boxd sandbox must be stopped before resume. Serialize its lifecycle and resolve any previous execution first."
      )
    }

    const sandbox = this.sandbox(client, machine, session, true)
    try {
      if (machine.status === "hibernated") await client.wake(machine.id)
      else await client.start(machine.id)
      await client.waitUntilReady(machine.id, this.readyTimeoutMs)
      await client.setEgress(machine.id, toBoxdEgress(session.network) ?? [])
      if (session.requestCredentials.length > 0) {
        await sandbox.installCredentials(session.requestCredentials)
      }
      // The working directory may be new to this session; the machine keeps everything else.
      await this.bootstrap(sandbox)
      return sandbox
    } catch (error) {
      // Leave the machine asleep, as it was, with no authority from this session.
      await sandbox.stop().catch(() => {})
      throw persistentError(error, "configure")
    }
  }

  /** Name the fix when no key was given: the SDK reports a missing key only at its first call. */
  private keyHint(): string {
    return this.defaults.apiKey || process.env.BOXD_API_KEY || process.env.BOXD_TOKEN
      ? ""
      : " Set BOXD_API_KEY or pass apiKey."
  }

  private get prefix(): string {
    return this.defaults.namePrefix ?? DEFAULT_NAME_PREFIX
  }

  private boxd(): BoxdClient {
    this.client ??= this.createClient({
      ...(this.defaults.apiKey === undefined ? {} : { apiKey: this.defaults.apiKey }),
      ...(this.defaults.baseURL === undefined ? {} : { baseURL: this.defaults.baseURL }),
      ...(this.defaults.region === undefined ? {} : { region: this.defaults.region }),
    })
    return this.client
  }

  /** This session's options over the factory's defaults, validated before anything is created. */
  private session(options: SandboxSessionOptions) {
    const network = options.network ?? this.configuration.network ?? { mode: "none" }
    const requestCredentials = options.requestCredentials ?? []
    toBoxdEgress(network)
    assertCredentialsAllowed(network, requestCredentials)
    return {
      workingDirectory: workspacePath(
        options.workingDirectory || this.defaults.workingDirectory || DEFAULT_WORKING_DIRECTORY
      ),
      env: { ...this.configuration.env, ...options.env },
      timeout: options.timeout ?? this.defaults.timeout,
      network,
      requestCredentials,
    }
  }

  private sandbox(
    client: BoxdClient,
    machine: BoxdMachineRecord,
    session: ReturnType<BoxdSandboxFactory["session"]>,
    persistent: boolean
  ): BoxdSandbox {
    return new BoxdSandbox({
      client,
      machineId: machine.id,
      machineName: machine.name,
      persistent,
      workingDirectory: session.workingDirectory,
      env: session.env,
      timeout: session.timeout,
      network: session.network,
      setupTimeoutMs: this.setupTimeoutMs,
    })
  }

  private async bootstrap(sandbox: BoxdSandbox): Promise<void> {
    const result = await sandbox.runSetup(bootstrapCommand(sandbox.workingDirectory))
    if (result.exitCode === BOOTSTRAP_NO_SUDO) {
      throw new SandboxError(
        `[Sandbox] boxd machine ${sandbox.id} needs passwordless sudo for its default user.`
      )
    }
    if (result.exitCode === BOOTSTRAP_NO_SETPRIV) {
      throw new SandboxError(`[Sandbox] boxd machine ${sandbox.id} has no setpriv.`)
    }
    if (result.exitCode !== 0) {
      throw new SandboxError(
        `[Sandbox] boxd could not prepare ${sandbox.workingDirectory} on ${sandbox.id}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
      )
    }
  }
}

/**
 * Sixb's sandbox names are longer than a machine name may be, so the machine is named after a
 * digest of it, and the name itself is kept in a label.
 */
export function persistentMachineName(prefix: string, name: string): string {
  return `${prefix}${createHash("sha256").update(name).digest("hex").slice(0, 24)}`
}

/**
 * The working directory becomes the command user's own, so it can't be a directory the system or
 * the machine's own user depends on.
 */
function workspacePath(path: string): string {
  const resolved = posix.resolve("/", path)
  const top = resolved.split("/")[1] ?? ""
  if (SHARED_DIRECTORIES.includes(resolved) || SYSTEM_TREES.includes(top)) {
    throw new SandboxError(
      `[Sandbox] boxd workingDirectory ${resolved} is a system directory; use one of its own, such as ${DEFAULT_WORKING_DIRECTORY}.`
    )
  }
  return resolved
}

const SHARED_DIRECTORIES = ["/", "/tmp", "/var", "/var/tmp", "/var/lib", "/opt", "/srv", "/mnt"]
const SYSTEM_TREES = [
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "proc",
  "root",
  "run",
].concat(["sbin", "sys", "usr"])

function egress(network: SandboxNetworkPolicy): { egress?: readonly string[] } {
  const entries = toBoxdEgress(network)
  return entries === undefined ? {} : { egress: entries }
}

function assertPersistentName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 256 ||
    name.trim() !== name ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new SandboxError(
      "[Sandbox] A sandbox name of 1 to 256 characters, without surrounding whitespace or control characters, is required."
    )
  }
}

function persistentError(
  error: unknown,
  operation: "create" | "resume" | "configure"
): SandboxError {
  if (error instanceof SandboxError) return error
  if (operation === "resume" && isNotFound(error)) {
    return new SandboxStateUnavailableError(
      "[Sandbox] boxd has no saved state for this sandbox name; no replacement was created."
    )
  }
  if (operation === "create" && isConflict(error)) {
    return new SandboxError(
      "[Sandbox] boxd sandbox name already exists. Resume its stopped state or choose a new name; nothing was overwritten."
    )
  }
  return new SandboxError(
    `[Sandbox] boxd persistent sandbox ${operation} failed: ${errorMessage(error)}`
  )
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SandboxError(`[Sandbox] boxd ${name} must be a positive number of milliseconds.`)
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
