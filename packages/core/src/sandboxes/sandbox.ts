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

/**
 * Options accepted by every SandboxFactory.create. Provider-specific factories
 * may extend this type with their own options.
 */
export interface CreateSandboxOptions {
  readonly workingDirectory?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeout?: number
  readonly network?: SandboxNetworkPolicy
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

  /** Mark the sandbox stopped; subsequent runCommand calls reject. Idempotent. */
  stop(): Promise<void>
  /** Stop and reclaim any provider-side resources. Idempotent. */
  destroy(): Promise<void>
}

/**
 * What createSixb({ sandboxes }) accepts. Provider-specific factories hold
 * their defaults set once and expose create(options) for each run.
 */
export interface SandboxFactory {
  create(options?: CreateSandboxOptions): Promise<Sandbox>
}
