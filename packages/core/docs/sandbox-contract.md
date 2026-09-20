# Sandbox contract

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## The contract

Two interfaces define the whole surface. A **`SandboxFactory`** holds the provider's defaults and is
passed once to `createSixb`. A **`Sandbox`** is one isolated environment that runs commands.

```ts
interface SandboxFactory {
  create(options?: CreateSandboxOptions): Promise<Sandbox>
  resume?(name: string, options?: ResumeSandboxOptions): Promise<Sandbox>
}

interface Sandbox {
  readonly id: string
  readonly provider: string // "local" | "apple-container" | "smolvm" | "vercel"
  readonly status: "running" | "stopped" | "failed"
  readonly workingDirectory: string

  runCommand(
    command: string,
    args?: readonly string[],
    options?: RunCommandOptions
  ): Promise<CommandResult>

  // Materialize files into the sandbox; a later runCommand can read them. Parent dirs are created.
  writeFiles(files: readonly SandboxFileRecord[]): Promise<void>

  stop(): Promise<void> // mark stopped; later runCommand rejects. Idempotent.
  destroy(): Promise<void> // stop and reclaim provider resources. Idempotent.
}
```

The worker calls `factory.create()` once per agent run, `writeFiles(...)` to install the CLI, skill,
and run context, and `runCommand(...)` per command. It calls `destroy()` on teardown.

### File materialization

`writeFiles` is how bytes get into a sandbox — the worker never writes to the host filesystem
directly. Each provider decides how a `SandboxFileRecord` (`{ path, contents, mode? }`) reaches the
guest: the local provider writes straight to the host filesystem it shares with the guest, while
smolvm executes an in-guest script that decodes the payload inside the VM. The only guarantee the
contract makes is observable: after `writeFiles`, the files exist at their paths for a subsequent
`runCommand`.

`runCommand` resolves with a `CommandResult` rather than throwing on a non-zero exit — a failed
command is data, not an exception:

| Field | Meaning |
| --- | --- |
| `exitCode` | Process exit code (`0` on success) |
| `stdout` | Captured standard output |
| `stderr` | Captured standard error |
| `durationMs` | Wall-clock run time |
| `timedOut` | `true` when the command was killed for exceeding its timeout |

`RunCommandOptions` overrides the sandbox-level defaults for a single call:

| Option | Meaning |
| --- | --- |
| `cwd` | Working directory for this command |
| `env` | Env merged on top of the sandbox env; per-call wins on collision |
| `timeout` | Timeout in milliseconds; on expiry the command is killed and `timedOut` is set |
| `signal` | An `AbortSignal` to cancel an in-flight command |

`CreateSandboxOptions` sets the per-run defaults at `create()` time: `workingDirectory`, `env`,
`timeout`, and `network`.

### Agent runtime profile

The generic `Sandbox` contract remains command-agnostic. The agent worker separately validates the
concrete provisioned environment against `sixb-agent-runtime/v1` before any model-issued sandbox
command can run. The profile requires behavior, not an `agentReady` provider flag:

- Bash must load the worker's `BASH_ENV` bootstrap.
- Standard file utilities must support bounded reads and output collection, including `realpath`,
  `tail`, `head`, `base64`, `find`, `wc`, and `tr`.
- Bun 1.3+ or Node 22+ must execute the portable `sixb` CLI.
- CA certificates must allow the CLI to reach an HTTPS API gateway.
- The installed CLI, file modes, `PATH`, and run environment must be correct.
- The CLI must reach and identify the run-scoped API gateway.

`curl` and `jq` are not runtime-profile dependencies because the production CLI uses the JavaScript
runtime's native fetch and JSON support. The worker performs one network-free behavioral probe
after materializing its files, then runs `sixb doctor` to verify the installed CLI contract and
project identity through the gateway. An incompatible environment cannot execute a sandbox
command. Its failure records the provider, profile, failed check, and safe failure classification
without recording raw command output or the gateway capability URL. Bake shared dependencies into
versioned images or snapshots; never install packages during an individual run.

### Optional filesystem persistence

Persistence is requested at creation with `persistence: { name }`. Providers supporting it expose
`factory.resume`; currently only Vercel does. Unsupported providers reject persistence before
provisioning, never silently falling back to an ephemeral sandbox.

```ts
if (!factory.resume) {
  throw new Error("This task requires persistent sandbox support.")
}

const first = await factory.create({ persistence: { name: "project-thread-workspace" } })
await first.writeFiles([{ path: "draft.txt", contents: "Uncommitted work" }])
await first.stop() // Resolves only after the provider confirms preservation.

const next = await factory.resume("project-thread-workspace")
await next.runCommand("cat", ["draft.txt"])
await next.stop()
```

Creation rejects an existing name. Resume requires stopped, existing state: an expired/deleted
snapshot throws `SandboxStateUnavailableError`, never an empty replacement. Retention belongs to
the provider configuration. Files are preserved, not running processes; this is not an independent
durable file store. Handles must not automatically boot another VM while running a command.

The caller owns namespacing and exclusive lifecycle access. This API is not a distributed lock:
serialize the whole operation, not just individual calls. Runtime options (`env`, `network`,
`workingDirectory`, command timeout) must be supplied on each acquisition. `ResumeSandboxOptions`
accepts only these session options, not `persistence` or creation settings. Persisted files are
untrusted and never establish execution authority. `destroy()` is an explicit permanent deletion
requiring exclusive ownership of the name, not routine teardown after a persistent run.

This is a provider capability only. Conversational agents, workflow nodes and subagents still use
the existing per-run ephemeral lifecycle; configuring snapshot retention does not opt them in.
