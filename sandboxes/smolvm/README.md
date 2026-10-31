# @sixb/sandboxes-smolvm

Runs each agent's sandbox tools inside a hardware-isolated
[smolvm](https://github.com/smol-machines/smolvm) microVM. Drop-in `Sandbox` provider — wire it once
into `createSixb({ sandboxes })`; nothing else changes.

Commands default to the sandbox's working directory, `/workspace` in the guest unless
`workingDirectory` says otherwise. Relative `cwd` values such as `"."` or
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
docker pull ghcr.io/sixb-ai/sixb-agent:<version>
docker save ghcr.io/sixb-ai/sixb-agent:<version> -o ~/.cache/sixb/sixb-agent.tar
```

Replace `<version>` with the current [`VERSION`](../agent-image/VERSION). A local archive boots
offline, with no registry access. Save it on a machine with the same architecture as the smolvm
host, or add `--platform linux/amd64` / `linux/arm64` to `docker pull`. The host that runs
sandboxes needs only smolvm and the `.tar`.

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
Networking is locked to the Sixb API — no open internet. Boot time scales with image size:
on Apple silicon the agent image takes about 10–20 seconds per run, a slim Node image under 2. If
the archive is missing, `create()` throws a message telling you what to run.

## Custom images

Any image works if it has Bash, standard file utilities, CA certificates, and Bun 1.3+ or Node 22+.
Extend the agent image with `FROM ghcr.io/sixb-ai/sixb-agent:<version>`, or use a smaller image for
faster boots. Run-time installs will not work: egress is locked down and commands are not root
(see below).

## Commands run unprivileged

Every command runs as uid 65534 (`nobody`) through `setpriv`, with no groups, capabilities or new
privileges. The working directory and the files `writeFiles` materializes belong to that user, so
commands can change them; elsewhere they can write only where the image lets anyone, such as
`/tmp`. Install tools in the image: a command can no longer install packages as root. The image
needs `setpriv` (util-linux, or BusyBox's).

## Request credentials

The factory supports request credentials (`supportsRequestCredentials`), such as the run token the
agent worker adds to every call its commands make to the Sixb API. A forwarder runs as root in the
guest and holds them; `credentialedUrl(url)` is its socket under `/var/lib/sixb-forward`, which
forwards only to `url` and adds the credential that matches the request. The credentials reach the
guest in a root process's environment, never in arguments, and stay in root-only files. The
forwarder needs Bun or Node in the image.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `image` | required | A local `.tar` path (offline), a registry ref (pulled at boot), or `null` for a bare busybox machine that cannot run the agent CLI. |
| `timeout` | — | Per-command timeout, in ms. |
| `overlayGiB` | smolvm default (2) | Writable-layer disk size; raise to avoid "no space left". |
| `env` | `{}` | Env merged into every run. |

## Network policy

The agent worker allows access to the Sixb API. When configuring a sandbox directly,
`network.mode` can disable networking (`"none"`), allow specific hosts (`"restricted"`), or allow
all outbound traffic (`"all"`).

Restricted policies are enforced by hostname, not port. An allowed host is reachable on any port.
Use a separate host for the Sixb API if other services on the same host must remain inaccessible.

Registry images need network access to pull at startup. The provider adds Docker Hub hosts to
restricted policies by default; set `registryHosts` for other registries. Local image archives
can boot without registry access.

## Dev note: localhost

A microVM can't reach a Sixb API on `localhost` — that's the VM's own loopback, not your host. In dev, point the API at your host's LAN IP so the sandbox can reach it:

```bash
SIXB_API_PUBLIC_ORIGIN=http://<host-lan-ip>:3002
```

The provider warns once if it sees a `localhost` Sixb API. (In production the API is already a real address, so this doesn't apply.)

## Tests

```bash
bun test sandboxes/smolvm/tests/   # VM tests skip without a smolvm binary
```

Pure unit tests cover the CLI flags and network policy; a fake `smolvm` covers the lifecycle and the
full data path; `smolvm-integration.test.ts` runs a real VM when a binary is present.
