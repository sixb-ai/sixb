# @sixb/sandboxes-vercel

Runs each agent's sandbox tools inside a managed [Vercel Sandbox](https://vercel.com/docs/sandbox)
Firecracker microVM. Drop-in `Sandbox` provider — wire it once into `createSixb({ sandboxes })`;
agent code still uses the provider-neutral Sixb sandbox contract.

## Setup

Install dependencies with Bun from the repo root:

```bash
bun install
```

The package uses Vercel's `@vercel/sandbox` SDK. Authentication is resolved by the SDK in one of two
ways:

- **OIDC**: on Vercel, OIDC is automatic when configured; locally, run `vercel link` and
  `vercel env pull` so `VERCEL_OIDC_TOKEN` is available.
- **Access token**: pass `credentials: { token, teamId, projectId }` to `VercelSandboxFactory` for
  non-Vercel workers or CI.

Local OIDC tokens expire; rerun `vercel env pull` if sandbox creation starts failing with auth
errors.

## Use

```ts
import { createSixb } from "@sixb/core"
import { VercelSandboxFactory } from "@sixb/sandboxes-vercel"

createSixb({ sandboxes: new VercelSandboxFactory() })
```

Each Sixb agent run creates a fresh Vercel sandbox, materializes skills/context with
`writeFiles(...)`, runs bash commands via `runCommand(...)`, then permanently deletes the sandbox on
`destroy()`.

Persistence is disabled by default (`persistent: false`) because Sixb sandboxes are per-run. If you
want a long-lived Vercel sandbox model, opt in explicitly and manage snapshot/storage cost.

## Gateway and network policy

The agent worker creates sandboxes with a restricted network policy that allows only the Sixb API
gateway. This provider maps Sixb policies to Vercel's firewall:

| Sixb policy | Vercel policy |
| --- | --- |
| `{ mode: "none" }` | `"deny-all"` |
| `{ mode: "all" }` | `"allow-all"` |
| HTTPS restricted origins | domain allow rules matched by TLS SNI |
| IP restricted origins | CIDR allow rules |

Important caveats:

- Vercel sandboxes run remotely. They cannot reach `localhost`, `127.0.0.1`, or your machine's
  loopback; those restricted targets are rejected.
- Vercel's domain firewall is TLS/SNI-based. Plain HTTP hostnames cannot be enforced as domain
  allow rules; use HTTPS or an IP/CIDR target.
- IP/CIDR rules are address-wide; the URL port is not enforced by the firewall rule.

For production, expose the Sixb API gateway at a public HTTPS origin reachable from Vercel.

## Runtime and dependencies

Sixb explicitly selects Vercel's stock `node24` runtime by default. Custom images and snapshots used
by agents must satisfy `sixb-agent-runtime/v1`: Bash, `realpath`, `tail`, `head`, `base64`, CA
certificates, and Bun 1.3+ or Node 22+. `curl` and `jq` are not required.

For additional tools, prefer one of these setup strategies:

| Strategy | Option | Notes |
| --- | --- | --- |
| Stock runtime | `runtime: "node24"` | Default, no image build. |
| Snapshot | `snapshotId: "..."` | Install deps once, snapshot, then boot future runs from it. |
| VCR image | `image: "sixb-agent:v1"` | Use a Vercel Container Registry image prepared from a Dockerfile. |

Avoid package installs on every agent run. If you do install at runtime, Vercel supports `sudo` and
`dnf`, but setup needs egress to package repositories.

## Options

```ts
new VercelSandboxFactory({
  runtime: "node24",
  sessionTimeoutMs: 10 * 60_000,
  timeout: 30_000,
  resources: { vcpus: 2 },
})
```

| Option | Default | Notes |
| --- | --- | --- |
| `runtime` | `node24` | `"node26"`, `"node24"`, `"node22"`, or `"python3.13"`; ignored with `image`/`snapshotId`. Python alone is not agent-profile compatible. |
| `image` | — | Vercel Container Registry image reference. |
| `snapshotId` | — | Boot from a Vercel Sandbox snapshot; mutually exclusive with `runtime`, `image`, and `source`. |
| `source` | — | Git or tarball source for Vercel to clone/mount at create time. |
| `resources` | Vercel default | `{ vcpus }`; memory is 2048 MB per vCPU. |
| `ports` | `[]` | Ports to expose through Vercel sandbox domains. |
| `sessionTimeoutMs` | Vercel default | Sandbox session lifetime; separate from Sixb's per-command timeout. |
| `timeout` | — | Default Sixb per-command timeout, in ms. |
| `setupTimeoutMs` | `30_000` | Timeout for provider setup commands like creating a custom working directory. |
| `persistent` | `false` | Auto-snapshot on stop; off by default for per-run sandboxes. |
| `credentials` | SDK OIDC/env resolution | `{ token, teamId, projectId }` for external workers. |
| `env` | `{}` | Env merged into every sandbox. |
| `network` | `{ mode: "none" }` | Default network policy; the agent worker normally overrides per run. |

## Examples

With explicit credentials on a non-Vercel worker:

```ts
new VercelSandboxFactory({
  credentials: {
    token: process.env.VERCEL_TOKEN!,
    teamId: process.env.VERCEL_TEAM_ID!,
    projectId: process.env.VERCEL_PROJECT_ID!,
  },
  sessionTimeoutMs: 10 * 60_000,
})
```

With a prebuilt VCR image:

```ts
new VercelSandboxFactory({
  image: "sixb-agent:v1",
  resources: { vcpus: 2 },
})
```

## Tests

```bash
bun --filter @sixb/sandboxes-vercel test
bun --filter @sixb/sandboxes-vercel typecheck
```

The regular test suite uses fakes and does not require Vercel credentials. A live smoke test is gated
behind an environment variable because it consumes metered Vercel Sandbox resources:

```bash
SIXB_VERCEL_SANDBOX_INTEGRATION=1 bun --filter @sixb/sandboxes-vercel test
```
