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

Each ephemeral Sixb agent run creates a fresh Vercel sandbox, materializes skills/context with
`writeFiles(...)`, runs bash commands via `runCommand(...)`, then permanently deletes the sandbox on
`destroy()`.

Creation is ephemeral by default. Opt into named persistence per call, and configure snapshot
retention on the factory.

### Explicit persistent lifecycle

`factory.create({ ...options, persistence: { name } })` creates a named persistent sandbox;
`factory.resume(name, options)` resumes it without a creation fallback. Both return
the normal Sixb sandbox handle. Use `stop()` to save and `destroy()` only for deliberate permanent
deletion. Conversation [sandbox bindings](../../docs/sandboxes/overview.md#keep-files-across-conversation-runs)
enable this lifecycle; other runs remain ephemeral.

```ts
const factory = new VercelSandboxFactory({
  snapshotExpiration: 7 * 24 * 60 * 60 * 1000,
  keepLastSnapshots: { count: 1 },
})

const sandbox = await factory.create({ persistence: { name: "my-workspace" } })
await sandbox.writeFiles([{ path: "draft.txt", contents: "Work in progress" }])
await sandbox.stop()

const resumed = await factory.resume("my-workspace")
await resumed.runCommand("cat", ["draft.txt"])
await resumed.stop()
```

- Names are scoped to the configured Vercel project. The caller must namespace and serialize their
  complete lifecycle; concurrent resume calls are not an atomic acquisition or a lease.
- Creation never overwrites an existing name. Resume rejects running/non-persistent sandboxes.
  Missing state throws `SandboxStateUnavailableError` from `@sixb/core/sandboxes`; the SDK's
  destructive `getOrCreate()` fallback is deliberately not used.
- Commands, file writes, network updates and stop target the acquired SDK `Session`, not an
  automatically-resuming named handle. They cannot migrate to a later VM after a timeout.
- Run env is supplied per command, not stored as named VM defaults. VM creation defaults to
  deny-all; the current session receives the requested network policy. Stop closes network access
  and checks the returned snapshot belongs to that session and was successfully created.
- Failure during setup stops an acquired session without deleting the saved state. An uncertain
  provider request may require inspecting the named resource before retrying; there is no automatic
  destructive recovery. A failed stop remains failed on subsequent calls.
- Provider image/source, session timeout and retention are creation settings, not reapplied on
  resume. Runtime options must be supplied again. Files can still contain anything guest code wrote;
  per-command env delivery is not a mechanism for hiding secrets from the guest.

Conversations opt in to persistence through a thread sandbox binding. Unbound runs, workflows and
subagents remain ephemeral; snapshot retention alone does not enable conversation continuity.

Migration: the former factory option `persistent` is rejected, including `false`. Remove it for
ephemeral creation; use `create({ persistence: { name } })` for confirmed preservation and explicit
resume. Retention alone does not enable persistence.

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
by agents need Bash, standard file utilities, CA certificates, and Bun 1.3+ or Node 22+. `curl` and
`jq` are not required.

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
| `runtime` | `node24` | `"node26"`, `"node24"`, `"node22"`, or `"python3.13"`; ignored with `image`/`snapshotId`. Python alone cannot execute the portable agent CLI. |
| `image` | — | Vercel Container Registry image reference. |
| `snapshotId` | — | Boot from a Vercel Sandbox snapshot; mutually exclusive with `runtime` and `image`. |
| `source` | — | Common Sixb HTTPS Git source; credentials and provider-specific clone options are not accepted. |
| `resources` | Vercel default | `{ vcpus }`; memory is 2048 MB per vCPU. |
| `ports` | `[]` | Ports to expose through Vercel sandbox domains. |
| `sessionTimeoutMs` | Vercel default | Sandbox session lifetime; separate from Sixb's per-command timeout. |
| `timeout` | — | Default Sixb per-command timeout, in ms. |
| `setupTimeoutMs` | `30_000` | Timeout for provider setup commands like creating a custom working directory. |
| `snapshotExpiration` | Vercel default | Snapshot TTL in ms for named persistent creation. Does not enable persistence. |
| `keepLastSnapshots` | Vercel default | Provider retention policy, e.g. `{ count: 1 }`. |
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

## Credential injection

Persistent sessions support `sandbox.setRequestCredentials()`: replace host-side Authorization
injection for exact HTTPS paths and GET/POST methods, or pass `[]` to remove it. Injection never
widens the egress allowlist, changes persistent defaults or writes secrets inside the VM.
The worker manages workspace token issuance, renewal and revocation; stop removes network access
before saving. This capability does not guarantee revocation after a worker crash.

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

Persistence tests use the installed SDK with a simulated transport: they make no Vercel requests
and incur no Vercel usage. There is no live persistence test. These tests verify the adapter's
behavior, not actual file preservation by the Vercel service.
