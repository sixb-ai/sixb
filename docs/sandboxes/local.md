# Local sandbox

`@sixb/sandboxes-local` runs agent commands as child processes on the host, wrapped in an OS-level
isolation backend when one is available. It is the default choice for development: it needs no
external service and always boots, falling back to passthrough when no sandboxing tool is present.

```ts
import { createSixb } from "@sixb/core"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"

createSixb({ sandboxes: new LocalSandboxFactory() })
```

See the [overview](./overview.md) for the shared `Sandbox` / `SandboxFactory` contract this provider
implements.

The built-in agent tools use the host's `PATH`. For agent use, the host needs Bash, the standard
file utilities used by reads and output collection, CA certificates, and either Bun 1.3+ or Node
22+. The agent worker validates the environment immediately after provisioning and reports the
failed behavior when a dependency is missing. The local provider does not install or modify host
tools. `curl` and `jq` are not required.

## Isolation backends

A backend wraps each command so it can restrict filesystem writes and outbound network. The provider
ships three:

| Backend | Platform | Mechanism |
| --- | --- | --- |
| `seatbelt` | macOS | `sandbox-exec` with a generated Seatbelt profile |
| `bwrap` | Linux | `bubblewrap` (`bwrap`) with bind mounts and namespaces |
| `none` | any | Passthrough — the command runs directly, no isolation |

## Auto-detection and fallback

By default (`isolation: "auto"`) the factory detects the right backend for the host:

- **macOS**: `seatbelt`, if `sandbox-exec` is on `PATH` and can actually apply a profile. If
  `sandbox-exec` is missing — or present but unable to apply a sandbox — it falls back to `none`.
- **Linux**: `bwrap`, if `bwrap` is on `PATH`. Otherwise `none`.
- **Any other platform**: `none`.

The fallback to `none` means the sandbox **always boots**, even on a host with no sandboxing tools —
which keeps local development friction-free. Pin a backend explicitly (`isolation: "seatbelt"` or
`"bwrap"`) when you want a hard requirement: if that backend is unavailable, `create()` throws a
`SandboxIsolationUnavailableError` rather than silently falling back. (`"none"` is always honored.)

## What each backend restricts

The active backend controls how much of the contract is actually enforced:

| Backend | Filesystem writes | Outbound network |
| --- | --- | --- |
| `seatbelt` | Denied except the working directory, temp dirs, and `readWritePaths` | Blocked when `network.mode` is `"none"`; otherwise host network |
| `bwrap` | Read-only bind of `/`; writable only on the working directory and `readWritePaths` | Blocked (no network namespace) when `network.mode` is `"none"`; otherwise host network |
| `none` | No restriction | No restriction |

Two things to keep in mind:

- **Network enforcement is all-or-nothing.** `seatbelt` and `bwrap` block outbound network only when
  `network.mode` is `"none"`. For `"restricted"` or `"all"` they fall through to full host network —
  the per-origin allow list is not enforced locally. For a true per-host allow list, use
  [smolvm](./smolvm.md).
- **Host env is not leaked.** Only a small allowlist (`PATH`, `HOME`, `LANG`, `TMPDIR`) is forwarded
  from the host; everything else the command sees comes from the sandbox `env` and per-call `env`.

When no `workingDirectory` is given, the sandbox creates a temp directory and removes it on
`destroy()`. A configured `workingDirectory` is created if missing and left in place.

## Options

Pass these to `new LocalSandboxFactory({ ... })`:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `isolation` | `"auto" \| "seatbelt" \| "bwrap" \| "none"` | `"auto"` | Backend to use. `"auto"` detects per host; a pinned backend throws if unavailable |
| `readOnlyPaths` | `string[]` | `[]` | Extra paths mounted read-only (`bwrap`) — informational under `seatbelt`, which denies writes globally |
| `readWritePaths` | `string[]` | `[]` | Extra paths the command may write to, beyond the working directory |
| `env` | `Record<string, string>` | `{}` | Default env merged into every sandbox the factory creates |
| `timeout` | `number` | — | Default per-command timeout in milliseconds |
| `network` | `SandboxNetworkPolicy` | `{ mode: "none" }` | Default network policy; overridable per `create()` |

`isolation`, `readOnlyPaths`, and `readWritePaths` are factory-level only. `env`, `timeout`, and
`network` can be overridden per run by the values the worker passes to `create(...)`.

## Configuration example

```ts
import { LocalSandboxFactory } from "@sixb/sandboxes-local"

const sandboxes = new LocalSandboxFactory({
  isolation: "auto",
  // Allow the agent to write to a shared scratch area in addition to the working directory.
  readWritePaths: ["/srv/sixb/scratch"],
  timeout: 30_000,
})
```

For production-grade isolation with a real per-host network allow list, reach for the
[smolvm provider](./smolvm.md).
