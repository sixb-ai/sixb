# Sandboxes

A sandbox is an isolated environment where an agent reads files and runs Bash commands. Reach for
one whenever an [agent](../models/built-in-agent.md) needs file work, scripts, or the `sixb` CLI. The
degree of filesystem, network, and process isolation depends on the provider you choose.

You pick a provider once and wire it into `createSixb`. Everything above the sandbox — the agent,
its sandbox tools, its run lifecycle — is written against one provider-agnostic contract, so
swapping providers never touches agent code.

## Runtime requirements

For agent use, the environment needs Bash, standard file utilities, CA certificates, and Bun 1.3+
or Node 22+. Sixb checks these requirements before running agent commands. Custom images should
include their dependencies ahead of time.

Isolation and network enforcement depend on the provider. Check the table below before choosing
one, especially for untrusted code.

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

## Lifecycle

Sixb creates a sandbox for each agent run, installs its CLI and project skills, then destroys it
when the run ends. Export files you need to keep through the agent's file tools.
The default agent network policy allows access to the Sixb API gateway only; enforcement depends
on the provider.

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
- [Agent tools and the gateway](../models/tools-and-authorization.md) — how sandbox tools reach files
  and the API gateway

## Optional filesystem persistence

The Vercel provider can preserve files between sandbox sessions with `persistence: { name }`
and `factory.resume(name)`. Other providers reject this option. Files survive; running processes do not.
See [Vercel persistence](vercel.md) for configuration and lifecycle requirements.

This capability does not change the built-in Agent, workflow nodes, or subagents: they still use
a fresh sandbox per run. Configuring snapshot retention alone does not enable a persistent workspace.
