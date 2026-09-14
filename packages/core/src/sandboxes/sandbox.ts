/**
 * Provider-agnostic sandbox surface.
 *
 * A Sandbox is the agent's command execution target. Concrete providers
 * implement this interface while consumers only depend on Sandbox and
 * SandboxFactory.
 */

export type SandboxStatus = "running" | "stopped" | "failed"

/**
 * Per-command overrides. Each field overrides the matching sandbox-level
 * default set at factory.create(...).
 */
export interface RunCommandOptions {
  /** Overrides the sandbox-level workingDirectory for this call. */
  readonly cwd?: string
  /** Merged on top of sandbox-level env. Per-call wins on collision. */
  readonly env?: Readonly<Record<string, string>>
  /** Overrides the sandbox-level timeout, in milliseconds. */
  readonly timeout?: number
  /** Per-call only; there is no sandbox-level equivalent. */
  readonly signal?: AbortSignal
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  /** True when the command was killed because it exceeded timeout. */
  readonly timedOut?: boolean
}

/**
 * A file to materialize into a sandbox via {@link Sandbox.writeFiles}. `contents` may be text or
 * raw bytes; providers that transport bytes out of process (e.g. into a VM) may base64-encode them.
 */
export interface SandboxFileRecord {
  /**
   * Path to the file, resolved within {@link Sandbox.workingDirectory}. Missing parent directories
   * are created. A provider that writes to the host (rather than an isolated guest) rejects a path
   * that escapes the working directory.
   */
  readonly path: string
  /** File contents, written byte-for-byte: a `string` is UTF-8, a `Uint8Array` is raw bytes. */
  readonly contents: string | Uint8Array
  /** Optional octal file mode (e.g. `0o755`), honored on POSIX-backed providers (local, smolvm). */
  readonly mode?: number
}

/**
 * Provider-level network egress policy:
 * - `none` — no outbound network.
 * - `restricted` — only the listed origins may be reached, so an empty `allow` list means deny-all
 *   on a provider that enforces egress (smolvm). Providers that CANNOT enforce a per-origin allow
 *   list (the local backend) degrade `restricted` to full host network and warn loudly — so on those
 *   providers `restricted` behaves like `all`, empty allow list included. Use an enforcing provider
 *   when egress must actually be constrained.
 * - `all` — unrestricted outbound network.
 */
export type SandboxNetworkPolicy =
  | { readonly mode: "none" }
  | {
      readonly mode: "restricted"
      readonly allow: readonly SandboxNetworkTarget[]
    }
  | { readonly mode: "all" }

export interface SandboxNetworkTarget {
  readonly name: string
  readonly origin: string
}

/** Current execution defaults, supplied on both creation and resume, never recovered from files. */
export interface SandboxSessionOptions {
  readonly workingDirectory?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeout?: number
  readonly network?: SandboxNetworkPolicy
}

/** Options accepted by every SandboxFactory.create. */
export interface CreateSandboxOptions extends SandboxSessionOptions {
  /** Create new named state; reject an existing name or unsupported persistence before provisioning. */
  readonly persistence?: { readonly name: string }
}

/** Resume changes execution defaults, not the identity or creation configuration of saved state. */
export interface ResumeSandboxOptions extends SandboxSessionOptions {
  readonly persistence?: never
}

export interface Sandbox {
  readonly id: string
  /** Provider id matching the package suffix, for example "local". */
  readonly provider: string
  readonly status: SandboxStatus
  readonly workingDirectory: string

  runCommand(
    command: string,
    args?: readonly string[],
    options?: RunCommandOptions
  ): Promise<CommandResult>

  /**
   * Materialize files into the sandbox so a subsequent {@link runCommand} can read them. Each
   * provider decides how the bytes reach the guest; the observable contract is:
   * - each file exists at its {@link SandboxFileRecord.path} afterwards, with missing parents created;
   * - an existing file is overwritten;
   * - `contents` is written byte-for-byte (a `string` as UTF-8, a `Uint8Array` as raw bytes);
   * - `mode` is applied where the provider's filesystem supports it;
   * - an empty batch is a no-op.
   *
   * Paths must resolve within {@link workingDirectory}. Rejects if the sandbox is not running.
   */
  writeFiles(files: readonly SandboxFileRecord[]): Promise<void>

  /** Stop this session; subsequent operations reject. Idempotent.
   * Persistent handles confirm preservation and share the outcome, including failure,
   * across repeated/concurrent calls.
   */
  stop(): Promise<void>
  /** Stop and reclaim resources, permanently deleting named state when persistent. Idempotent.
   * Requires exclusive lifecycle ownership, including after stop(); never routine persistent teardown.
   */
  destroy(): Promise<void>
}

/**
 * What createSixb({ sandboxes }) accepts. Provider-specific factories hold
 * their defaults set once and expose create(options) for each run.
 * Persistent files are retention-bound, not a durable file store or a distributed lock.
 * Callers own namespacing and must serialize the entire create/resume/use/stop/destroy lifecycle.
 * Credentials and current authority must be supplied again, never inferred from saved files.
 */
export interface SandboxFactory {
  /** Create an ephemeral sandbox unless persistence is requested. Existing names must fail,
   * never attach or overwrite. Unsupported providers must reject persistence before provisioning.
   * A persistent handle targets one session; operations must not automatically resume another VM.
   */
  create(options?: CreateSandboxOptions): Promise<Sandbox>
  /**
   * Present only when named persistent creation and resume are supported.
   * Resume an existing, stopped sandbox. Missing/expired state throws SandboxStateUnavailableError;
   * it must never create an empty replacement. An already running sandbox must be rejected.
   * Returns a handle bound to the resumed session, with no automatic resume on use.
   * Runtime options must be provided again; no creation settings or persistence option are accepted.
   */
  resume?(name: string, options?: ResumeSandboxOptions): Promise<Sandbox>
}
