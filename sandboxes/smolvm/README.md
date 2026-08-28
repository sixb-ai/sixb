# @sixb/sandboxes-smolvm

Runs each agent's sandbox tools inside a hardware-isolated
[smolvm](https://github.com/smol-machines/smolvm) microVM. Drop-in `Sandbox` provider — wire it once
into `createSixb({ sandboxes })`; nothing else changes.

## Setup

Two one-time steps.

**1. Install the smolvm binary** (Linux also needs `/dev/kvm`):

```bash
curl -sSL https://smolmachines.com/install.sh | bash
```

**2. Build the agent image** (needs Docker or Podman):

```bash
bun run agent:image
```

This builds [`agent-image/Dockerfile`](./agent-image/Dockerfile) — pinned Node 22 on Alpine plus
Bash, Git, certificates, ripgrep, and Python — and caches the versioned image at
`~/.cache/sixb/smolvm/sixb-agent-runtime-v1.tar`. Alpine's BusyBox base supplies `realpath`, `tail`,
`head`, and `base64` for `read`.

## Use

```ts
import { createSixb } from "@sixb/core"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"

createSixb({ sandboxes: new SmolvmSandboxFactory() })
```

Each run boots a microVM from the cached image, runs the agent's sandbox tools, and destroys it.
Networking is locked to the sixb gateway — no open internet. Boot (~0.7 s) overlaps the model's
first response, so it's effectively instant. If a setup step is missing, `create()` throws a message
telling you exactly what to run.

## Custom tools

Edit the Dockerfile and rebuild. Custom agent images must satisfy `sixb-agent-runtime/v1`: Bash,
`realpath`, `tail`, `head`, `base64`, CA certificates, and Bun 1.3+ or Node 22+. `curl` and `jq` are
not required. Keep the image lean — boot time scales with image size, and run-time installs will not
work because egress is locked down.

```bash
# edit agent-image/Dockerfile, then:
bun run agent:image
```

## Production (no Docker on the server)

Docker is only needed to *build* the image. The server needs only the smolvm binary and the `.tar`. Build for the server's architecture on any machine with Docker, copy it over, and point `image` at it.

```bash
bun run agent:image --platform linux/amd64
# Built agent image -> ~/.cache/sixb/smolvm/sixb-agent-runtime-v1-amd64.tar
scp ~/.cache/sixb/smolvm/sixb-agent-runtime-v1-amd64.tar server:/opt/sixb/agent.tar
```

```ts
new SmolvmSandboxFactory({ image: "/opt/sixb/agent.tar" })
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `image` | cached managed archive | A local `.tar` path (offline), or a registry ref like `node:22` (pulled at boot). |
| `timeout` | — | Per-command timeout, in ms. |
| `overlayGiB` | smolvm default (2) | Writable-layer disk size; raise to avoid "no space left". |
| `env` | `{}` | Env merged into every run. |

## Dev note: localhost

A microVM can't reach a gateway on `localhost` — that's the VM's own loopback, not your host. In dev, point the API at your host's LAN IP so the sandbox can reach it:

```bash
SIXB_API_PUBLIC_ORIGIN=http://<host-lan-ip>:3002
```

The provider warns once if it sees a `localhost` gateway. (In production the gateway is already a real address, so this doesn't apply.)

## Tests

```bash
bun test sandboxes/smolvm/tests/   # VM tests skip without a smolvm binary
```

Pure unit tests cover the CLI flags and network policy; a fake `smolvm` covers the lifecycle and the full data path; `smolvm-integration.test.ts` runs a real VM when a binary is present.

After building the managed image, run its agent-runtime conformance smoke explicitly:

```bash
SIXB_SMOLVM_AGENT_RUNTIME_INTEGRATION=1 bun test sandboxes/smolvm/tests/smolvm-integration.test.ts
```
