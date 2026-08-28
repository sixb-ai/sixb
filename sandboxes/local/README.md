# @sixb/sandboxes-local

Local process sandbox provider for Sixb agents.

Runs each agent's sandbox tools on the host machine, confined by the OS sandbox facility when
available: `sandbox-exec` (seatbelt) on macOS, `bwrap` (bubblewrap) on Linux. Drop-in `Sandbox`
provider — wire it once into `createSixb({ sandboxes })` and nothing else changes.

The host must satisfy `sixb-agent-runtime/v1`: Bash with `BASH_ENV` support; `realpath`, `tail`,
`head`, and `base64`; CA certificates; and Bun 1.3+ or Node 22+. `curl` and `jq` are not required.

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
| `readOnlyPaths` / `readWritePaths` | The filesystem the agent may see. Everything else is denied by the sandbox profile. |
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
