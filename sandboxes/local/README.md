# @sixb/sandboxes-local

Local process sandbox provider for Sixb agents.

Runs each agent's sandbox tools on the host machine, confined by the OS sandbox facility when
available: `sandbox-exec` (seatbelt) on macOS, `bwrap` (bubblewrap) on Linux. Drop-in `Sandbox`
provider — wire it once into `createSixb({ sandboxes })` and nothing else changes.

Commands default to the sandbox's working directory. Relative `cwd` values such as `"."` or
`"src"` resolve against that directory; absolute paths override it for that call only.

For agent use, the host needs Bash with `BASH_ENV` support, standard file utilities, CA
certificates, and Bun 1.3+ or Node 22+. The provider does not install or modify host tools. `curl`
and `jq` are not required.

## Install

```bash
bun add @sixb/sandboxes-local
```

## Usage

```ts
import { LocalSandboxFactory } from "@sixb/sandboxes-local"

export const sixb = createSixb({
  storage,
  broker,
  sandboxes: new LocalSandboxFactory({
    isolation: "auto",
    readOnlyPaths: [process.cwd()],
    readWritePaths: [".sixb/agent-work"],
    timeout: 120_000,
  }),
})
```

| Option | Purpose |
| --- | --- |
| `isolation` | `"auto"` (default) picks the backend for the platform; `"seatbelt"` and `"bwrap"` demand a specific one; `"none"` disables confinement. |
| `readOnlyPaths` / `readWritePaths` | Additional read-only mounts for bwrap and writable paths for OS sandbox backends. These do not prevent reading other host files. |
| `env` | Default environment merged into every sandbox. Only `PATH`, `HOME`, `LANG`, and `TMPDIR` are inherited from the host — nothing else leaks in. |
| `timeout` | Default command timeout, overridable per run. |
| `network` | Default network policy, overridable per run. |

## Isolation is best-effort

With `isolation: "auto"` on a platform where neither backend is available — and always with
`isolation: "none"` — the agent's tools run as ordinary child processes of your application, with
that process's privileges. That is fine for local development and wrong for anything running
untrusted instructions.

For real isolation, use a provider that puts a boundary around the workload:
[`@sixb/sandboxes-apple-container`](../apple-container),
[`@sixb/sandboxes-smolvm`](../smolvm), or [`@sixb/sandboxes-vercel`](../vercel).

Pin `isolation` to `"seatbelt"` or `"bwrap"` to require that backend. Creation fails if it is
unavailable instead of falling back to an ordinary child process.

## Network policy

Seatbelt and bwrap block outbound network when `network.mode` is `"none"`. Both `"restricted"`
and `"all"` allow full host network access; the per-origin allow list is not enforced. With
`isolation: "none"`, network access is unrestricted regardless of the policy.
