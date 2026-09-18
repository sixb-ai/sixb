# @sixb/sandboxes-azure

Run Sixb agent commands in Azure Container Apps Sandboxes.

> **Preview:** ephemeral sandboxes only. No named persistence or resume.
> Restricted networking supports public HTTPS origins on port 443.

```text
Your deployment creates once       Sixb creates for each agent run
────────────────────────────       ──────────────────────────────
Sandbox group + worker access  →   Sandbox → commands/files → destroy
Optional reusable disk image
```

[Setup](#setup) · [Production auth](#production-auth) · [Images](#images) ·
[Sandbox API](#sandbox-api) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting)

## Setup

### 1. Install the provider

From an existing Sixb project running Bun 1.4.2 or later:

```sh
bun add @sixb/sandboxes-azure
```

### 2. Create an Azure sandbox group

Open the [Azure Sandboxes portal](https://sandboxes.azure.com/) and create a group.
Follow Microsoft's [portal quickstart](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-quickstart-portal)
for the current preview setup flow.

| Azure setting | Example |
| --- | --- |
| Subscription | Your application's subscription |
| Resource group | `sixb-dev` |
| Sandbox group | `sixb-dev` |
| Region | `westus3` — used in this provider's live tests |
| Capacity | Enough concurrent sandboxes for your agent workers |

> The factory uses an **existing** group. Create infrastructure and assign access
> through Azure or your application's deployment tooling.

### 3. Set the connection values

```dotenv
# .env.local — local development; use deployment environment variables in production
AZURE_SUBSCRIPTION_ID=<subscription-id>
AZURE_RESOURCE_GROUP=sixb-dev
AZURE_SANDBOX_GROUP=sixb-dev
AZURE_SANDBOX_REGION=westus3
```

These identify resources; they are not credentials. The factory receives them explicitly
in step 5 rather than reading these environment variables automatically.

### 4. Authenticate locally

Install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli), then sign in:

```sh
az login
az account set --subscription "<subscription-id>"
```

Your signed-in user needs **Container Apps SandboxGroup Data Owner** on this group.
If access has not already been assigned, an administrator with role-assignment
permission can grant it using [Azure RBAC](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-cli):

```sh
# Set the scope to the sandbox group you just created.
SIXB_SANDBOX_SCOPE="/subscriptions/<subscription-id>/resourceGroups/sixb-dev/providers/Microsoft.App/sandboxGroups/sixb-dev"

az role assignment create \
  --assignee-object-id "<your-user-object-id>" \
  --assignee-principal-type User \
  --role "Container Apps SandboxGroup Data Owner" \
  --scope "$SIXB_SANDBOX_SCOPE"
```

To find your own user object ID:

```sh
az ad signed-in-user show --query id --output tsv
```

### 5. Configure Sixb

```ts
// sandbox.ts
import { AzureSandboxFactory } from "@sixb/sandboxes-azure"

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

export const sandboxes = new AzureSandboxFactory({
  subscriptionId: requiredEnv("AZURE_SUBSCRIPTION_ID"),
  resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
  sandboxGroup: requiredEnv("AZURE_SANDBOX_GROUP"),
  region: requiredEnv("AZURE_SANDBOX_REGION"),
  image: { type: "public", name: "node-22" },
  workingDirectory: "/workspace",
  timeout: 30_000,
})
```

Add the factory to your existing configuration. Keep your project's storage, models
and other providers:

```diff
 // sixb.config.ts
+import { sandboxes } from "./sandbox"

 export const sixb = createSixb({
   // Your existing project configuration...
+  sandboxes,
 })
```

Omitting `credential` uses Azure's `DefaultAzureCredential`, including Azure CLI
credentials for local development. For an explicit production identity, see below.

### 6. Make the Sixb API reachable

The sandbox calls your **Sixb API server** to run commands such as `sixb objects get`.
It needs a public HTTPS URL reachable from Azure.

| URL | Supported for the agent gateway? |
| --- | --- |
| `https://api.example.com` | Yes |
| `https://your-tunnel.ngrok.app` | Yes, for local development |
| `http://localhost:3002` | No — localhost is inside the remote sandbox |
| `https://api.example.com:8443` | No — restricted mode supports port 443 only |
| Azure AI Foundry / model-provider URL | This is not the Sixb API gateway |

For local development, start a tunnel to the port your Sixb API will use:

```sh
# Terminal 1 — ngrok must be installed and authenticated.
ngrok http http://localhost:3002 --inspect=false
```

Then start Sixb with the HTTPS origin printed by ngrok:

```sh
# Terminal 2 — from your Sixb project
bun sixb dev \
  --api-port 3002 \
  --api-public-origin https://your-tunnel.ngrok.app
```

Use a development project with synthetic data: this tunnel exposes its local API.
For a separately deployed agent worker, point it at your deployed API:

```sh
bun sixb worker agent \
  --api-public-origin https://api.example.com \
  --concurrency 2
```

The worker automatically requests restricted access to the API origin, installs the
Sixb CLI and run context, runs `sixb doctor`, and destroys the sandbox after the run.
Model-provider credentials stay with your existing worker configuration.

## Production auth

### Managed identity

1. Enable a system-assigned identity, or attach a user-assigned identity, on the
   Azure resource hosting your worker.
2. Grant that identity the same group-scoped data role.
3. Pass the corresponding credential to the factory.

```sh
# Run as your deployment administrator; scope is the production sandbox group.
az role assignment create \
  --assignee-object-id "<worker-identity-principal-id>" \
  --assignee-principal-type ServicePrincipal \
  --role "Container Apps SandboxGroup Data Owner" \
  --scope "/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.App/sandboxGroups/<sandbox-group>"
```

Install Azure Identity as a direct dependency when importing it in your project:

```sh
bun add @azure/identity
```

```ts
import { ManagedIdentityCredential } from "@azure/identity"

// System-assigned identity attached to the worker:
const credential = new ManagedIdentityCredential()

// Or select a user-assigned identity attached to the worker:
const userAssignedCredential = new ManagedIdentityCredential({
  clientId: "<worker-identity-client-id>",
})
```

Add `credential` (or `credential: userAssignedCredential`) to the factory options in
`sandbox.ts`. See [Azure's credential reference](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/managedidentitycredential).

| Value | Used for |
| --- | --- |
| Identity **principal ID** | Azure role assignment |
| Identity **client ID** | Selecting a user-assigned identity in code |
| Client secret | Not needed for managed identity |

> Passing a client ID does not attach the identity to the worker. Configure that
> attachment in your Azure deployment. Runtime credentials never enter the sandbox.

For workers hosted outside Azure, pass an appropriate Azure `TokenCredential` or
configure `DefaultAzureCredential` for your environment. See the
[Azure Identity authentication guide](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/overview).

## Images

### Start with a public image

```ts
image: { type: "public", name: "node-22" }
```

### Pin a reusable image

Import an OCI image once into your group using Microsoft's
[ACA CLI](https://github.com/microsoft/azure-container-apps/blob/main/plugin/skills/aca-sandboxes/references/reference.md).
`aca` is a separate sandbox CLI from `az containerapp`.

```sh
aca config set \
  --subscription "<subscription-id>" \
  --resource-group "<resource-group>" \
  --sandbox-group "<sandbox-group>" \
  --region westus3

aca doctor
```

This is the Linux/amd64 Node 22 Debian image used in the live agent tests:

```sh
aca sandboxgroup disk create \
  --image docker.io/library/node@sha256:87a4f951f28b85d189df365d24c479d3bdb70be77c1ff5c9029db2ef67e251ac \
  --name sixb-agent-runtime-v1-node22-1

aca sandboxgroup disk list
```

Wait for **Ready**, then reuse the returned disk image ID:

```ts
image: { type: "disk", id: "<disk-image-id>" }
```

| Image requirement | Purpose |
| --- | --- |
| Node 22+ and Bash | Supervisor and Sixb agent CLI |
| Coreutils, `env`, `unshare`, `setpriv` | File tools and unprivileged command execution |
| System CA bundle | TLS verification through Azure's inspection proxy |
| Root setup and writable cgroup v2 with `cgroup.kill` / `cgroup.freeze` | Cancellation and safe file publication |

The tested image already has the required tools. Plain Ubuntu without Node does not.
Sixb installs its matching CLI and run context per session; do not bake credentials
or run tokens into images. Use a new image version for upgrades. After an interrupted
import, inspect the image list before retrying to avoid duplicates.

## Sandbox API

Use the factory directly when you need commands/files outside an agent run:

```ts
import { sandboxes } from "./sandbox"

const sandbox = await sandboxes.create()
try {
  await sandbox.writeFiles([
    { path: "hello.txt", contents: "Hello from Sixb\n" },
    { path: "data.bin", contents: new Uint8Array([0, 1, 254, 255]) },
    { path: "scripts/run.sh", contents: "#!/bin/bash\ncat hello.txt\n", mode: 0o755 },
  ])

  const result = await sandbox.runCommand("bash", ["scripts/run.sh"], {
    cwd: "/workspace",
    env: { TASK_ID: "example" },
    timeout: 10_000,
    signal: AbortSignal.timeout(15_000),
  })

  console.log(result.exitCode, result.stdout, result.stderr)
} finally {
  await sandbox.destroy()
}
```

| Behavior | Contract |
| --- | --- |
| Arguments | Literal argv; use `bash -c` explicitly for shell syntax |
| Environment | Factory → create → command; later values win; host env is not inherited |
| Timeout | Exit `137`, `timedOut: true`, collected output preserved |
| Cancellation | Exit `137` without `timedOut` when cancellation wins |
| Output limit | 1 MiB per stream; overflow fails and reclaims the VM |
| Background processes | All descendants are killed before the command returns |
| Files | UTF-8 or bytes, nested paths, overwrite and POSIX modes |
| File boundary | Paths stay in the workspace; symlinks are rejected |
| File ownership | UID/GID 65534; new files default to `0644` |
| Overwrite mode | Preserved unless explicitly supplied |
| Batch writes | Atomic per file, not transactional across the batch |
| `stop()` | Closes the handle; does not replace ephemeral cleanup |
| `destroy()` | Deletes the sandbox and confirms absence; repeated calls share the outcome |

Workloads run without capabilities and with no-new-privileges enabled. File publication
briefly freezes workloads to prevent path-swap races; command deadlines keep running.
Use a dedicated workspace without symlink components. System directories are rejected.

## Networking

```ts
// Default: no outbound network, including DNS.
const offline = await sandboxes.create({ network: { mode: "none" } })
```

```ts
// Allow only the listed public HTTPS origins.
const restricted = await sandboxes.create({
  network: {
    mode: "restricted",
    allow: [{ name: "sixb-api", origin: "https://api.example.com" }],
  },
})
```

```ts
// Unrestricted outbound network.
const connected = await sandboxes.create({ network: { mode: "all" } })
```

Always destroy each handle in `finally`, as in the API example above.

| Policy | Behavior |
| --- | --- |
| `none` or restricted with `allow: []` | Isolated command network namespace; DNS blocked; no shared loopback |
| `restricted` | Public DNS HTTPS origins on port 443; Azure DNS resolver remains accessible |
| `all` | Guest outbound network with Azure inspection disabled |

**Restricted targets reject:** HTTP, nonstandard ports, IP literals, local hostnames,
wildcards, URL credentials, paths, queries and fragments. Pass an origin such as
`https://api.example.com`, not a URL containing `/api`.

The final policy is applied at creation, before workload execution. Restricted Node
commands use `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` to trust Azure's
injected CA while preserving TLS verification. Explicit environment overrides apply.
Do not disable certificate verification to fix a trust error.

## Configuration

| Factory option | Default / requirement |
| --- | --- |
| `subscriptionId`, `resourceGroup`, `sandboxGroup`, `region` | Required; existing Azure public-cloud group |
| `image` | Required; public image name or imported disk image ID |
| `credential` | `DefaultAzureCredential` |
| `resources` | `{ vcpus: 1, memoryMiB: 2048, diskGiB: 20 }` |
| `workingDirectory` | `/workspace` |
| `env` | No caller-supplied values |
| `network` | `{ mode: "none" }` |
| `timeout` | `300_000` ms per command |
| `requestTimeoutMs` | `30_000` ms per Azure request, including authentication and response body |
| `provisionTimeoutMs` | `120_000` ms for creation, readiness and guest setup |
| `teardownTimeoutMs` | `60_000` ms for each remote stop/delete confirmation |
| `pollIntervalMs` | `1_000` ms for lifecycle polling |

`create()` can override `workingDirectory`, `env`, `network` and `timeout`.
The setup example chooses a 30-second command timeout instead of the five-minute default.

> **Cleanup:** always call `destroy()` for ephemeral work. The provider also requests
> idle suspension after 300 seconds and an auto-delete interval of 600 seconds as
> crash-recovery safeguards. These are separate from command deadlines.

## Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Authentication failed | Run `az login` locally; verify the attached identity and client ID in Azure |
| HTTP 403 | Check the group-scoped Data Owner role; allow time for RBAC propagation |
| Provisioning failed | Check region, group capacity, resource sizing and image readiness |
| `sixb doctor` / gateway preflight failed | Check the public HTTPS Sixb API origin and image tools/CA bundle |
| Node TLS error | Preserve the injected system CA bundle and check `NODE_EXTRA_CA_CERTS` overrides |
| Guest artifact unavailable in a source checkout | Run `bun --filter @sixb/sandboxes-azure build:guest` |
| Create response was uncertain | Inspect the reported `sixb-provisioning-id` label before retrying |
| Deletion could not be confirmed | Reclaim the sandbox ID reported in the error using Azure tooling |

- Mutations are not automatically replayed. Unknown command/file outcomes close the
  session and trigger VM deletion; failed cleanup reports the sandbox ID.
- Stop/destroy settle active work before remote teardown. Handles never auto-resume.
- Keep exclusive ownership of each sandbox: out-of-band root commands or egress-policy
  changes through Azure APIs are outside the provider's guarantees.
- Retain the shared group/image between runs. Remove them and their role assignments
  through Azure when retiring the environment.

### Availability and cost

| Item | What to verify |
| --- | --- |
| Regions | `westus3` has live test coverage; check current Azure availability for other regions |
| Capacity | Match worker concurrency to group and subscription quotas |
| Billing | Check Azure pricing/cost views, including retained storage and images |
| Preview compatibility | Azure may change APIs or require resources to be recreated |

See [Azure's sandbox overview](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview).

## Development and tests

<details>
<summary>Commands for contributors working in the Sixb repository</summary>

Published packages include the compiled guest artifact. Rebuild it after changing
the supervisor in a source checkout:

```sh
bun --filter @sixb/sandboxes-azure build:guest
bun test sandboxes/azure/tests/
bun --filter @sixb/sandboxes-azure test:e2e
```

The package E2E command checks packed imports, types and the guest artifact offline.
Live Azure tests require a disposable group and data access configured separately:

```sh
export AZURE_SUBSCRIPTION_ID="<subscription-id>"
export AZURE_RESOURCE_GROUP="<test-resource-group>"
export AZURE_SANDBOX_GROUP="<test-sandbox-group>"
export AZURE_SANDBOX_REGION="westus3"

SIXB_AZURE_E2E=1 bun test \
  ./sandboxes/azure/tests/command-execution.e2e.ts \
  ./sandboxes/azure/tests/file-materialization.e2e.ts \
  ./sandboxes/azure/tests/network.e2e.ts
```

Full agent integration additionally requires an imported image and authenticated ngrok:

```sh
AZURE_SANDBOX_IMAGE_ID="<disk-image-id>" \
SIXB_AZURE_AGENT_E2E=1 \
bun test ./sandboxes/azure/tests/agent-runtime.e2e.ts
```

This test uses a deterministic model, synthetic data and the real worker/CLI/gateway.
It exposes only capability-authenticated gateway routes through a temporary tunnel.
Live tests delete their sandboxes and close their tunnels; the shared group/image remain.

</details>
