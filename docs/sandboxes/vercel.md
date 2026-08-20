# Vercel sandbox

Use `@sixb/sandboxes-vercel` to run the agent's sandbox tools in managed Vercel Sandbox microVMs.
It is a drop-in sandbox provider for `createSixb({ sandboxes })`.

Choose this provider when you want strong hosted isolation and do not want to install a local
hypervisor or build a smolvm image on your worker host.

## Quick start

Install the provider:

```bash
bun add @sixb/sandboxes-vercel
```

Wire it into your Sixb runtime:

```ts
import { createSixb } from "@sixb/core"
import { VercelSandboxFactory } from "@sixb/sandboxes-vercel"

export const sixb = createSixb({
  // ...storage, broker, queues, ontology, agents
  sandboxes: new VercelSandboxFactory({
    timeout: 30_000, // default per-command timeout
    sessionTimeoutMs: 10 * 60_000, // Vercel VM lifetime
  }),
})
```

That is all the Sixb code you need. The agent worker will create one Vercel sandbox per agent run,
write the run context into it, execute its sandbox tools, and delete the sandbox on teardown.

## Required: a Vercel project

Vercel Sandboxes are scoped to a Vercel project. You do not need to deploy an app, but you do need a
linked project for auth, usage, snapshots, and observability.

For local development:

```bash
vercel link
vercel env pull .env.local
```

`vercel env pull` writes a development `VERCEL_OIDC_TOKEN`. The token expires, so run it again if
sandbox creation starts failing with auth errors.

For a worker running outside Vercel, pass access-token credentials:

```ts
new VercelSandboxFactory({
  credentials: {
    token: process.env.VERCEL_TOKEN!,
    teamId: process.env.VERCEL_TEAM_ID!,
    projectId: process.env.VERCEL_PROJECT_ID!,
  },
})
```

When running on Vercel with OIDC configured, you can omit `credentials`; the Vercel SDK resolves them
from the environment.

## Required: a reachable API origin

The agent sandbox talks to Sixb through the run-scoped API gateway. Because Vercel sandboxes run
remotely, they cannot reach your local `localhost`.

For local development, expose the Sixb API with an HTTPS tunnel and set the public API origin:

```bash
SIXB_API_PUBLIC_ORIGIN=https://your-tunnel.example.com
bun sixb dev
```

For production, use the public HTTPS origin of your Sixb API server.

The provider rejects restricted gateway origins that are clearly unreachable or unsafe to enforce:

- `localhost` / `127.0.0.1` / loopback addresses
- plain HTTP hostnames, because Vercel's domain firewall is TLS/SNI-based

## Network policy

Sixb's agent worker creates sandboxes with restricted egress to the Sixb API gateway. The Vercel
provider maps Sixb policies to Vercel's firewall:

| Sixb policy | Vercel behavior |
| --- | --- |
| `{ mode: "none" }` | deny all egress |
| `{ mode: "all" }` | allow all egress |
| restricted HTTPS origins | allow those domains by TLS SNI |
| restricted IP origins | allow those IPs as CIDRs |

IP/CIDR rules are address-wide; the URL port is not enforced by the firewall rule.

## Runtime and tools

The default Vercel runtime is `node24`. That is the recommended starting point.

```ts
new VercelSandboxFactory({
  runtime: "node24",
})
```

The stock Vercel runtimes include the commands used by Sixb's built-in agent tools. A custom image
or snapshot must provide `bash`, `curl`, `realpath`, `tail`, `head`, and `base64`. On a
Debian-compatible image, the last four come from `coreutils`.

For heavier setup, prefer a snapshot or Vercel Container Registry image instead of installing
packages on every agent run:

```ts
// Start from a Vercel Sandbox snapshot
new VercelSandboxFactory({
  snapshotId: "snp_...",
})

// Or start from a VCR image
new VercelSandboxFactory({
  image: "sixb-agent:v1",
})
```

Runtime package installs are possible with Vercel `sudo` + `dnf`, but setup commands need egress to
package repositories and add latency to every run.

## Common options

| Option | What it does |
| --- | --- |
| `timeout` | Default per-command timeout in milliseconds. |
| `sessionTimeoutMs` | Vercel sandbox session lifetime. Different from `timeout`. |
| `runtime` | Stock Vercel runtime: `node26`, `node24`, `node22`, or `python3.13`. |
| `image` | Vercel Container Registry image reference. |
| `snapshotId` | Existing Vercel Sandbox snapshot to boot from. |
| `resources` | Vercel resources, e.g. `{ vcpus: 2 }`. |
| `env` | Environment variables merged into every sandbox command. |
| `credentials` | Explicit Vercel `{ token, teamId, projectId }` for non-OIDC environments. |
| `persistent` | Defaults to `false`; set `true` only if you intentionally want Vercel snapshots. |

## Example configurations

Default hosted sandbox:

```ts
new VercelSandboxFactory({
  timeout: 30_000,
  sessionTimeoutMs: 10 * 60_000,
})
```

More CPU:

```ts
new VercelSandboxFactory({
  resources: { vcpus: 4 },
  sessionTimeoutMs: 20 * 60_000,
})
```

External worker with explicit credentials:

```ts
new VercelSandboxFactory({
  credentials: {
    token: process.env.VERCEL_TOKEN!,
    teamId: process.env.VERCEL_TEAM_ID!,
    projectId: process.env.VERCEL_PROJECT_ID!,
  },
  timeout: 30_000,
})
```

## Related

- [Sandboxes overview](./overview.md)
- [Agent tools and the gateway](../agents/tools-and-gateway.md)
- [smolvm sandbox](./smolvm.md)
