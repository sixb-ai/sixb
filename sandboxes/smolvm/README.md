# @sixb/sandboxes-smolvm

Runs each agent's sandbox tools inside a hardware-isolated
[smolvm](https://github.com/smol-machines/smolvm) microVM. Drop-in `Sandbox` provider — wire it once
into `createSixb({ sandboxes })`; nothing else changes.

Commands default to the sandbox's working directory. Relative `cwd` values such as `"."` or
`"src"` resolve against that directory; absolute paths select a guest directory for that call only.

## Setup

Two one-time steps.

**1. Install the smolvm binary** (Linux also needs `/dev/kvm`):

```bash
curl -sSL https://smolmachines.com/install.sh | bash
```

**2. Save the [Sixb agent image](../agent-image/README.md) as a local archive** (needs Docker or
Podman on the machine that saves it):

```bash
mkdir -p ~/.cache/sixb
docker pull ghcr.io/sixb-ai/sixb-agent:1.2.0
docker save ghcr.io/sixb-ai/sixb-agent:1.2.0 -o ~/.cache/sixb/sixb-agent.tar
```

A local archive boots offline, with no registry access. Save it on a machine with the same
architecture as the smolvm host, or add `--platform linux/amd64` / `linux/arm64` to `docker pull`.
The host that runs sandboxes needs only smolvm and the `.tar`.

## Use

```ts
import { homedir } from "node:os"
import { createSixb } from "@sixb/core"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"

createSixb({
  sandboxes: new SmolvmSandboxFactory({ image: `${homedir()}/.cache/sixb/sixb-agent.tar` }),
})
```

Each run boots a microVM from the image, runs the agent's sandbox tools, and destroys it.
Networking is locked to the sixb gateway — no open internet. Boot time scales with image size: the
agent image takes about 20 seconds per run on Apple silicon. If the archive is missing, `create()`
throws a message telling you what to run.

## Custom images

Any image works if it has Bash, standard file utilities, CA certificates, and Bun 1.3+ or Node 22+.
Extend the agent image with `FROM ghcr.io/sixb-ai/sixb-agent:1.2.0`, or use a smaller image for
faster boots. Run-time installs will not work because egress is locked down.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `image` | required | A local `.tar` path (offline), a registry ref (pulled at boot), or `null` for a bare busybox machine that cannot run the agent CLI. |
| `timeout` | — | Per-command timeout, in ms. |
| `overlayGiB` | smolvm default (2) | Writable-layer disk size; raise to avoid "no space left". |
| `env` | `{}` | Env merged into every run. |

## Network policy

The agent worker allows access to the Sixb gateway. When configuring a sandbox directly,
`network.mode` can disable networking (`"none"`), allow specific hosts (`"restricted"`), or allow
all outbound traffic (`"all"`).

Restricted policies are enforced by hostname, not port. An allowed host is reachable on any port.
Use a separate gateway host if other services on the same host must remain inaccessible.

Registry images need network access to pull at startup. The provider adds Docker Hub hosts to
restricted policies by default; set `registryHosts` for other registries. Local image archives
can boot without registry access.

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

Pure unit tests cover the CLI flags and network policy; a fake `smolvm` covers the lifecycle and the
full data path; `smolvm-integration.test.ts` runs a real VM when a binary is present.
