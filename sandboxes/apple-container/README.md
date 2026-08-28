# @sixb/sandboxes-apple-container

Runs each agent's sandbox tools inside a local [Apple Container](https://github.com/apple/container)
container. Drop-in `Sandbox` provider - wire it once into `createSixb({ sandboxes })`; agent code
still uses the provider-neutral Sixb sandbox contract.

## Setup

Install Apple Container on an Apple silicon Mac running macOS 26 or newer, then make sure the
`container` CLI is on `PATH`.

```bash
container system start
```

The default is the official `node:22-bookworm` multi-platform image pinned to an immutable OCI
digest. Custom agent images must satisfy `sixb-agent-runtime/v1`:

- `bash`
- `/bin/sh`
- `realpath`, `tail`, `head`, and `base64` for the built-in `read` tool
- CA certificates and Bun 1.3+ or Node 22+ for the portable `sixb` CLI
- `dirname`, `mkdir`, `cat`, and optionally `chmod` for file materialization

`curl` and `jq` are not required.

## Use

```ts
import { createSixb } from "@sixb/core"
import { AppleContainerSandboxFactory } from "@sixb/sandboxes-apple-container"

createSixb({ sandboxes: new AppleContainerSandboxFactory() })
```

Each run creates a fresh container, starts it with a small keep-alive command, materializes
skills/context through `writeFiles(...)`, runs commands with `container exec`, then stops and deletes
the container on `destroy()`.

## Network Policy

Apple Container's documented CLI does not expose per-origin egress allow-listing. This provider maps
Sixb's network policies conservatively where it can:

| Sixb policy | Apple Container behavior |
| --- | --- |
| `{ mode: "none" }` | Creates a per-sandbox internal network and attaches the container to it. |
| `{ mode: "all" }` | Attaches the container to `defaultNetworkName` (`"default"` by default). |
| `{ mode: "restricted" }` | Warns and degrades to the configured default network. |

The downgrade matches Sixb's provider contract for backends that cannot enforce restricted egress.
Use `@sixb/sandboxes-smolvm` or `@sixb/sandboxes-vercel` when the agent gateway must be the only
reachable origin.

## Options

```ts
new AppleContainerSandboxFactory({
  timeout: 30_000,
  memory: "2G",
  cpus: 2,
  dns: ["8.8.8.8"],
  ports: [3000],
})
```

| Option | Default | Notes |
| --- | --- | --- |
| `image` | pinned `node:22-bookworm` | OCI image used for each sandbox. |
| `bin` | `container` | Apple Container CLI binary name or absolute path. |
| `timeout` | - | Default per-command timeout, in ms. |
| `setupTimeoutMs` | `30_000` | Timeout for provider bootstrap/cleanup commands. |
| `memory` | Apple default | Passed to `container create --memory`. |
| `cpus` | Apple default | Passed to `container create --cpus`. |
| `dns` | `[]` | DNS servers passed with `container create --dns`; useful if Apple Container's default DNS proxy (`192.168.64.1`) does not resolve from guests. |
| `ports` | `[]` | Publishes `127.0.0.1:<port>:<port>/tcp`. |
| `mounts` | `[]` | Bind-mount host directories with `container create --mount`. |
| `createArgs` | `[]` | Extra args passed to `container create` before the image name. |
| `defaultNetworkName` | `default` | Network used for `all` and downgraded `restricted`. |
| `internalNetworkPrefix` | `sixb-apple-net-` | Prefix for per-sandbox internal networks. |
| `env` | `{}` | Env merged into every sandbox. |
| `network` | `{ mode: "none" }` | Default network policy; the agent worker normally overrides per run. |

## Tests

```bash
bun --filter @sixb/sandboxes-apple-container test
bun --filter @sixb/sandboxes-apple-container typecheck
```

The regular test suite uses a fake `container` CLI and does not require macOS. A live smoke test is
gated behind an environment variable:

```bash
SIXB_APPLE_CONTAINER_INTEGRATION=1 bun --filter @sixb/sandboxes-apple-container test
```
