# Sandboxes

A sandbox is an isolated environment where an agent reads files and runs Bash commands. Reach for
one whenever an [agent](../agents/overview.md) needs file work, scripts, or the `sixb` CLI. The
sandbox keeps that work off your host — its filesystem, network, and processes are walled off from
the machine the runtime runs on.

You pick a provider once and wire it into `createSixb`. Everything above the sandbox — the agent,
its sandbox tools, its run lifecycle — is written against one provider-agnostic contract, so
swapping providers never touches agent code.

## The contract

Two interfaces define the whole surface. A **`SandboxFactory`** holds the provider's defaults and is
passed once to `createSixb`. A **`Sandbox`** is one isolated environment that runs commands.

```ts
interface SandboxFactory {
  create(options?: CreateSandboxOptions): Promise<Sandbox>
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

## Wiring

Construct a factory and pass it as `sandboxes`:

```ts
import { createSixb } from "@sixb/core"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"

export const sixb = await createSixb({
  // ...broker, storage, queues, ontology, agents
  sandboxes: new LocalSandboxFactory(),
})
```

Switching to stronger isolation is a one-line change — the rest of the app is unaffected:

```ts
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"

createSixb({ sandboxes: new SmolvmSandboxFactory() })
```

Or use Vercel-hosted Firecracker microVMs when the agent worker already has Vercel Sandbox
credentials and the Sixb API gateway is reachable from Vercel:

```ts
import { VercelSandboxFactory } from "@sixb/sandboxes-vercel"

createSixb({ sandboxes: new VercelSandboxFactory() })
```

On Apple silicon Macs, Apple Container is another local option:

```ts
import { AppleContainerSandboxFactory } from "@sixb/sandboxes-apple-container"

createSixb({ sandboxes: new AppleContainerSandboxFactory() })
```

## Network policy

Every provider speaks the same `SandboxNetworkPolicy`. It is set per-run at `create(...)` (or as a
factory default) and governs what the sandbox can reach over the network:

| Mode | Meaning |
| --- | --- |
| `{ mode: "none" }` | No outbound network (the default when none is set) |
| `{ mode: "restricted", allow: [...] }` | Only the listed origins are reachable |
| `{ mode: "all" }` | Unrestricted egress (discouraged in production) |

Each `restricted` entry is a `{ name, origin }` target, for example
`{ name: "sixb-api", origin: "http://10.0.0.5:3002" }`.

Providers differ in how precisely they can enforce `restricted`. The [smolvm](./smolvm.md) provider
enforces a real per-host allow list inside the microVM. The [Vercel](./vercel.md) provider maps
restricted HTTPS origins to Vercel's TLS/SNI firewall and IP origins to CIDR rules. The
[local](./local.md) and [Apple Container](./apple-container.md) providers are all-or-nothing today:
`none` blocks outbound network, any other mode allows host/default network. The contract is the same;
read each provider page for what it actually enforces.

## How agents use a sandbox

You rarely call `runCommand` yourself. The agent worker does it:

1. When a run starts, the worker calls `factory.create(...)` with a **restricted** network policy
   whose only allowed origin is the sixb API gateway. The agent can reach the gateway and nothing
   else.
2. Sandbox boot overlaps the model's first response — it is provisioned concurrently and each
   sandbox tool awaits it lazily on first use, so boot latency does not block the turn.
3. Each `read` call runs a fixed, bounded script with model input passed as command arguments. Each
   `bash` call becomes `runCommand("bash", ["-lc", script], ...)`.
4. On run teardown the worker calls `destroy()`.

Because egress is locked to the gateway, the agent's only way to read or write app data is through
that gateway — there is no open internet. See
[Agent tools and the gateway](../agents/tools-and-gateway.md) for what the gateway exposes.

## Choosing a provider

| Provider | Package | Isolation | Use when |
| --- | --- | --- | --- |
| [Local](./local.md) | `@sixb/sandboxes-local` | OS sandboxing (seatbelt / bwrap) or passthrough | Development and local iteration |
| [Apple Container](./apple-container.md) | `@sixb/sandboxes-apple-container` | Local Apple Container runtime | Local Mac testing with container isolation |
| [smolvm](./smolvm.md) | `@sixb/sandboxes-smolvm` | Hardware-isolated microVM | Production on hosts where you can run smolvm |
| [Vercel](./vercel.md) | `@sixb/sandboxes-vercel` | Vercel-hosted Firecracker microVM | Production on Vercel, or hosted workers with Vercel Sandbox credentials |

Rule of thumb: **local or Apple Container for dev, smolvm or Vercel for stronger isolation in prod.**
The local provider is friction-free and always boots. Apple Container gives Mac users a local
containerized runtime. smolvm gives each run its own microVM with a true per-host egress allow list.
Vercel gives you remote managed microVMs, but the Sixb API gateway must be reachable from Vercel
(usually a public HTTPS origin, not localhost).

## Related

- [Local sandbox](./local.md) — OS-level isolation backends and auto-detection
- [Apple Container sandbox](./apple-container.md) — local Apple Container-backed sandboxes
- [smolvm sandbox](./smolvm.md) — hardware-isolated microVMs
- [Vercel sandbox](./vercel.md) — managed Vercel-hosted microVMs
- [Agent tools and the gateway](../agents/tools-and-gateway.md) — how sandbox tools reach files
  and the API gateway
