# smolvm sandbox

`@sixb/sandboxes-smolvm` runs each agent's sandbox tools inside a hardware-isolated
[smolvm](https://github.com/smol-machines/smolvm) microVM. Reach for it in production, or whenever
you want stronger isolation than the [local](./local.md) provider's OS sandboxing: every run gets
its own VM with a real per-host network allow list, and the guest filesystem and processes are fully
separated from the host.

```ts
import { createSixb } from "@sixb/core"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"

createSixb({ sandboxes: new SmolvmSandboxFactory() })
```

It implements the same `Sandbox` / `SandboxFactory` contract as every provider — see the
[overview](./overview.md). Swapping in this factory is the only code change.

## How a run works

Per agent run the factory creates a machine, boots it from an image, runs the agent's tools through
`smolvm machine exec`, then stops and deletes the machine on teardown. The guest filesystem is fully
isolated from the host — there is no bind mount. Files the worker needs in the guest (skills, run
context) are materialized **in-guest** by `writeFiles`, which executes a short script inside the VM
that base64-decodes each payload into place under the working directory.

Boot is fast (well under the model's first-response latency), so the VM is ready before the agent
asks for it.

## Preflight requirements

Host availability is probed once, lazily, on the first `create()`. If a requirement is missing,
`create()` throws a `SandboxIsolationUnavailableError` with a message telling you exactly what to do.
Requirements:

- The `smolvm` binary must be on `PATH` (or pass an absolute path via `bin`).
- On **Linux**, `/dev/kvm` must be present (KVM virtualization). macOS uses Hypervisor.framework and
  is not probed beyond the binary.

Install the binary once:

```bash
curl -sSL https://smolmachines.com/install.sh | bash
```

## The agent image

The VM boots from an OCI image that contains the tooling the agent uses. The package ships a
versioned canonical `sixb-agent-runtime/v1` image: pinned Node 22 on Alpine plus Bash, Git,
certificates, ripgrep, and Python. Alpine's BusyBox base provides the `realpath`, `tail`, `head`,
and `base64` commands used by the built-in `read` tool. `curl` and `jq` are not required by the
portable CLI.

Build it once with Docker or Podman. The build is the only step that needs a container builder; every
run after reads the cached archive offline.

```bash
bun run agent:image
```

This builds `agent-image/Dockerfile` and caches the archive at
`~/.cache/sixb/smolvm/sixb-agent-runtime-v1.tar` (honoring `XDG_CACHE_HOME`). The versioned cache
name prevents an older image from silently surviving a runtime-profile change. To add tools, edit
the Dockerfile and rebuild — keep it lean, and remember run-time installs will not work because
egress is locked to the gateway.

The previous unversioned `sixb-agent.tar` is intentionally not selected. Re-run `bun run
agent:image` once when upgrading to runtime-v1.

Custom archives and registry images used by agents must satisfy `sixb-agent-runtime/v1`: Bash,
`realpath`, `tail`, `head`, `base64`, CA certificates, and Bun 1.3+ or Node 22+. A bare BusyBox
machine is not a complete Sixb agent image.

For a server that has no Docker, cross-build the image elsewhere and copy it over. The build writes an
arch-suffixed file so it does not clobber the host build:

```bash
bun run agent:image --platform linux/amd64
# Built agent image -> ~/.cache/sixb/smolvm/sixb-agent-runtime-v1-amd64.tar
scp ~/.cache/sixb/smolvm/sixb-agent-runtime-v1-amd64.tar server:/opt/sixb/agent.tar
```

The server then needs only the `smolvm` binary and the `.tar`.

## Image modes

The `image` option selects what the VM boots from:

| `image` value | Mode | Behavior |
| --- | --- | --- |
| `undefined` (default) | Managed archive | The cached `sixb-agent-runtime-v1.tar` (or a cross-built `sixb-agent-runtime-v1-<arch>.tar` in the cache). Offline, fast, strict egress |
| a local `.tar` / `.tar.gz` / `.tgz` path | Local archive | Loaded at start with no network; boots fully offline |
| a registry reference (e.g. `"node:22"`) | Registry pull | Pulled from the registry **at start**, from inside the guest |
| `null` | Bare machine | smolvm's built-in busybox rootfs; no image, fully offline |

A registry-pull image is the only mode that needs network at boot: the pull happens inside the guest,
so the machine must be able to reach the registry. With `network.mode: "none"` the pull fails — use a
local archive or a bare machine for fully offline boot, or a `restricted` policy (see below) so the
registry hosts are reachable.

## Network and allow-hosts

The provider translates `SandboxNetworkPolicy` into smolvm flags:

- `{ mode: "none" }` — the VM gets no network.
- `{ mode: "restricted", allow: [...] }` — `--net` plus one `--allow-host` per allowed origin.
- `{ mode: "all" }` — `--net` with no allow list (discouraged in production).

This is the provider that actually enforces the contract's per-host allow list — it is strictly
stronger than the local backend's all-or-nothing network toggle.

Two security notes worth knowing:

- **`--allow-host` is hostname-granular, not port-scoped.** smolvm allows a hostname (resolved at VM
  start) with no port, so an allowed host is reachable on **any** port. If the gateway shares a host
  with other services, isolate it on its own host/IP when per-port egress matters.
- **A microVM has its own network stack.** A gateway advertised on `localhost` is the VM's loopback,
  not your host, so it is unreachable under restricted egress. Point the API at the host's LAN IP
  (e.g. `SIXB_API_PUBLIC_ORIGIN=http://<host-lan-ip>:3002`). The provider warns once if it sees a
  `localhost` target. In production the gateway is already a real address, so this does not apply.

When the image is a registry reference, the provider automatically augments a `restricted` policy
with the registry hosts (Docker Hub by default) so the in-guest pull at start can reach the registry
while staying scoped. Override the hosts with `registryHosts` for other registries.

## Options

Pass these to `new SmolvmSandboxFactory({ ... })`:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `image` | `string \| null` | managed cached archive | See [image modes](#image-modes). A path is a local archive; a registry ref pulls at boot; `null` is a bare machine |
| `bin` | `string` | `"smolvm"` | smolvm binary name (resolved on `PATH`) or an absolute path |
| `storageGiB` | `number` | smolvm default (20) | `--storage`: OCI layers + container data |
| `overlayGiB` | `number` | smolvm default (2) | `--overlay`: persistent rootfs changes; raise to avoid "no space left" |
| `registryHosts` | `string[]` | Docker Hub hosts | Registry hosts added to a restricted policy so a registry-pull image can fetch at start |
| `env` | `Record<string, string>` | `{}` | Default env merged into every sandbox the factory creates |
| `timeout` | `number` | — | Default per-command timeout in milliseconds |
| `network` | `SandboxNetworkPolicy` | `{ mode: "none" }` | Default network policy; overridable per `create()` |

`env`, `timeout`, and `network` can be overridden per run by the worker; the rest are factory-level.

## Configuration examples

Default — managed cached image, gateway-only egress applied by the worker:

```ts
new SmolvmSandboxFactory()
```

Point at a prebuilt archive copied onto a production server:

```ts
new SmolvmSandboxFactory({ image: "/opt/sixb/agent.tar" })
```

Pull a public registry image at boot, allowing GitHub Container Registry hosts:

```ts
new SmolvmSandboxFactory({
  image: "node:22",
  registryHosts: ["ghcr.io", "pkg-containers.githubusercontent.com"],
})
```

Bare machine (no image), with a larger writable overlay:

```ts
new SmolvmSandboxFactory({ image: null, overlayGiB: 8 })
```

## Related

- [Sandboxes overview](./overview.md) — the shared contract and network model
- [Local sandbox](./local.md) — OS-level isolation for development
- [Agent tools and the gateway](../agents/tools-and-gateway.md) — what the sandbox tools reach
