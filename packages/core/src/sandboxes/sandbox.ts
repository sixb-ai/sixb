/**
 * Provider-agnostic sandbox surface.
 *
 * A Sandbox is the agent's command execution target. Concrete providers
 * implement this interface while consumers only depend on Sandbox and
 * SandboxFactory.
 */

import type { ParamsConfig } from "../shared/params/types"
import type { SandboxConfig, SandboxEnvironment } from "./configuration"

export type SandboxStatus = "running" | "stopped" | "failed"

/**
 * Per-command overrides. Each field overrides the matching sandbox-level
 * default set at factory.create(...).
 */
export interface RunCommandOptions {
  /**
   * Working directory for this call. Defaults to the sandbox's workingDirectory;
   * relative paths resolve against it, while absolute paths override it.
   */
  readonly cwd?: string
  /** Merged on top of sandbox-level env. Per-call wins on collision. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Overrides the sandbox-level timeout, in milliseconds. One above the sandbox's
   * {@link Sandbox.maxCommandTimeout} is capped to it.
   */
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

/** HTTP methods a request credential can be injected into. HEAD and OPTIONS never are. */
export type SandboxRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/**
 * Credentials injected into matching requests where guest commands can't reach them. Guest
 * commands never hold them: not in env, files, process arguments or anything else they can read.
 * A firewall or a host forwarder keeps them outside the guest; a VM guest may keep them in files
 * only its root forwarder reads, while its commands run as an unprivileged user.
 *
 * A credential selects which requests receive its Authorization header. It does not decide what
 * the guest can reach, which is the network policy, nor which resources the token can act on:
 * the token's own permissions are the boundary, so issue it with the narrowest scope that works.
 *
 * Providers apply the same rules so that a credential means the same thing everywhere:
 * - `origin` is one `https://` domain: no port, path, user info, IP address, loopback host or
 *   `*` wildcard. A provider whose credentials are added on the host it runs on, rather than at a
 *   remote egress, may also accept an `http://` origin, such as a local development API.
 * - A path is matched case-sensitively against the raw request path. It starts with a single
 *   "/" and is printable ASCII without spaces, control characters, "?", "#", "%", "\\", or "."
 *   and ".." segments. A prefix also ends with "/", so it stops at a segment boundary.
 * - Two credentials must not match the same request: one credential per request, so providers
 *   reject the overlap instead of picking one.
 * - Only Authorization can be set, and the provider forces the request's Host header to
 *   `origin`'s domain.
 */
export interface SandboxRequestCredential {
  readonly origin: string
  /** One exact path, or every path under `prefix`. */
  readonly path: string | { readonly prefix: string }
  /** One method, or a non-empty list of distinct methods. */
  readonly method: SandboxRequestMethod | readonly SandboxRequestMethod[]
  readonly headers: { readonly Authorization: string }
}

/** Current execution defaults, supplied on both creation and resume, never recovered from files. */
export interface SandboxSessionOptions {
  /** Apply outside the guest before source/setup or resumed commands. Reject if unsupported. */
  readonly requestCredentials?: readonly SandboxRequestCredential[]
  readonly workingDirectory?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeout?: number
  readonly network?: SandboxNetworkPolicy
}

/** Options accepted by every SandboxFactory.create. */
export interface CreateSandboxOptions extends SandboxSessionOptions {
  /** Cancel initialization; a provider request already in flight may still finish. */
  readonly signal?: AbortSignal
  /** Replaces static source/setup, including {} to skip both. Required for dynamic recipes. */
  readonly environment?: Pick<SandboxEnvironment, "source" | "setup">
  /** Create new named state; reject an existing name or unsupported persistence before provisioning. */
  readonly persistence?: { readonly name: string }
  /**
   * Guest ports the host reaches through {@link Sandbox.url}, such as a server a command starts.
   * Kept for the sandbox's life, resumes included. Reject before provisioning when the provider
   * can't serve them.
   */
  readonly ports?: readonly number[]
}

/** Resume changes execution defaults, not the identity or creation configuration of saved state. */
export interface ResumeSandboxOptions extends SandboxSessionOptions {
  readonly persistence?: never
}

/** A command {@link Sandbox.start} left running. */
export interface SandboxProcess {
  /** Settles with the exit code once the command ends, however it ends. Never rejects. */
  readonly exited: Promise<number>
  /** Ends the command and everything it started. Idempotent. */
  kill(): Promise<void>
}

export interface Sandbox {
  readonly id: string
  /** Provider id matching the package suffix, for example "local". */
  readonly provider: string
  readonly status: SandboxStatus
  readonly workingDirectory: string
  /**
   * The longest timeout a command can have here, in milliseconds: the provider's own limit, or
   * the longest a JavaScript timer holds (`MAX_TIMER_DELAY_MS`). `runCommand` caps a longer one to it
   * rather than fail, and a command that runs that long ends `timedOut`, as at any timeout. Every
   * provider should declare it. A caller asks for the timeout it wants and lets the provider cap it.
   */
  readonly maxCommandTimeout?: number

  /** Optional secure injection capability. Replaces all credentials on this session only.
   * An empty list removes injection. Guest commands must never be able to read a secret.
   * Must not resume a stopped session or change defaults inherited by future sessions.
   * Renewal, ephemeral or persistent, targets the handle's session; after stop() it rejects.
   * A thrown error is reported to onError: it and its causes must never contain a credential.
   */
  readonly setRequestCredentials?: (
    credentials: readonly SandboxRequestCredential[]
  ) => Promise<void>

  /**
   * The address guest commands use to reach `url` with this session's request credentials added
   * out of their reach. It is `url` itself where a firewall adds them, or another address, such as
   * `unix:/path/to.sock`, that forwards only to `url`. Present on every sandbox of a factory that
   * advertises `supportsRequestCredentials`.
   */
  readonly credentialedUrl?: (url: string) => string

  /**
   * Run a command and gather its result. A request the provider refused before anything ran
   * rejects with {@link SandboxRequestRefusedError}; any other rejection may have run it.
   */
  runCommand(
    command: string,
    args?: readonly string[],
    options?: RunCommandOptions
  ): Promise<CommandResult>

  /**
   * Starts a command that keeps running after the call returns, such as a server. It ends when
   * it exits, is killed, or the session stops. Its output is discarded: a command that needs a
   * log writes one. Optional, with {@link url} and {@link keepAlive}: a sandbox that has all three
   * can serve a long-lived process to the host.
   */
  readonly start?: (
    command: string,
    args?: readonly string[],
    options?: Pick<RunCommandOptions, "cwd" | "env">
  ) => Promise<SandboxProcess>

  /** The address the host reaches `port` at, one of the `ports` the sandbox was created with. */
  readonly url?: (port: number) => string

  /** Pushes the session's deadline out by `ms`, so a process it serves isn't cut off. */
  readonly keepAlive?: (ms: number) => Promise<void>

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
export interface SandboxFactory<in out TParams extends ParamsConfig = ParamsConfig> {
  /**
   * Commands run on the host's own kernel and network, as `@sixb/sandboxes-local`'s do: nothing
   * keeps what they start from the host's services and files. Hosted branches refuse it in
   * production.
   */
  readonly sharesHost?: boolean
  /**
   * Its sandboxes keep a server running and serve its port (`start`, `url`): what a hosted branch
   * runs on. A provider that does not say so runs none, and production says so before it clones.
   */
  readonly runsBranches?: boolean
  /**
   * Supports initial and renewable request credentials on ephemeral and named sessions. An
   * agent's sandboxes need it: the run's token for the Sixb API is one of the credentials.
   */
  readonly supportsRequestCredentials?: boolean
  /**
   * Request credentials reach guest commands only through the forwarder at
   * {@link Sandbox.credentialedUrl}, never on their own requests: a plain `git clone https://…`
   * carries none. A hosted branch of a private repository refuses such a provider.
   */
  readonly forwardsRequestCredentials?: boolean
  /** Common host-side environment recipe. Never a discovered Agent definition. */
  readonly configuration?: SandboxConfig<TParams>
  /** Create an ephemeral sandbox unless persistence is requested. Existing names must fail,
   * never attach or overwrite. Apply the selected source/setup once, after session settings.
   * Dynamic resolution and source authorization belong to the caller, never the provider.
   * Unsupported providers must reject persistence before provisioning.
   * A persistent handle targets one session; operations must not automatically resume another VM.
   */
  create(options?: CreateSandboxOptions): Promise<Sandbox>
  /**
   * Present only when named persistent creation and resume are supported.
   * Resume an existing, stopped sandbox. Missing/expired state throws SandboxStateUnavailableError;
   * it must never create an empty replacement. Transport/auth/setup errors must not be classified
   * as missing state. An already running sandbox must be rejected with SandboxStillRunningError.
   * Returns a handle bound to the resumed session, with no automatic resume on use.
   * Runtime options must be provided again; no creation settings or persistence option are accepted.
   * Never clone or replay setup on resume.
   */
  resume?(name: string, options?: ResumeSandboxOptions): Promise<Sandbox>
  /**
   * Optional, with `resume`. Deletes the named sandbox and its saved state, running or stopped,
   * without a session: it needs no credentials and resumes nothing. A name already gone resolves.
   * Any other failure rejects, so a caller keeps the name and tries again: a sandbox it forgot
   * would keep its files, and its name, for good.
   */
  destroy?(name: string): Promise<void>
  /**
   * Optional, with `resume`. Stops the named sandbox's running session as its own handle's
   * `stop()` would, saving its state, for a caller that lost that handle (its process died). A
   * sandbox not running, or a name gone, resolves; any other failure rejects.
   */
  stop?(name: string): Promise<void>
}
