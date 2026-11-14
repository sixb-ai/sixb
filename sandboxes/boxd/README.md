# @sixb/sandboxes-boxd

Run Sixb agent commands in [boxd](https://boxd.sh?ref=sixb) machines: Ubuntu microVMs that
hibernate with their memory and disk, and wake where they left off.

```text
Ephemeral (each agent run)          Named (a conversation's workspace)
──────────────────────────          ──────────────────────────────────
create → commands/files → destroy   create → run → stop (hibernate) → resume → run → ...
```

[Setup](#setup) · [Sandbox API](#sandbox-api) · [Persistence](#persistence) ·
[Request credentials](#request-credentials) · [Networking](#networking) ·
[Configuration](#configuration) · [Development and tests](#development-and-tests)

## Setup

### 1. Install the provider

From an existing Sixb project running Bun 1.4.2 or later:

```sh
bun add @sixb/sandboxes-boxd
```

### 2. Create an API key

Install the [boxd CLI](https://docs.boxd.sh/cli/installation?ref=sixb), log in, and create a key
for your workers. `--org` fences the key to one organization; leave it out for personal machines.

```sh
boxd auth login
boxd auth keys create sixb-worker --org acme
```

```dotenv
# .env.local for local development; use deployment environment variables in production
BOXD_API_KEY=bxd_...
```

The factory reads `BOXD_API_KEY` when you don't pass `apiKey`. On a boxd machine without a key,
the SDK acts with that machine's own login instead, so set the key explicitly for workers that
run on boxd.

### 3. Configure Sixb

```ts
// sandbox.ts
import { BoxdSandboxFactory } from "@sixb/sandboxes-boxd"

export const sandboxes = new BoxdSandboxFactory({
  org: "acme",
  region: "fra",
  timeout: 30_000,
})
```

Add the factory to your existing configuration. Keep your project's storage, models and other
providers:

```diff
 // sixb.config.ts
+import { sandboxes } from "./sandbox"

 export const sixb = createSixb({
   // Your existing project configuration...
+  sandboxes,
 })
```

### 4. Make the Sixb API reachable

The machine calls your **Sixb API server** to run commands such as `sixb objects get`, so the API
needs a public HTTPS URL. `http://localhost:3002` is inside the remote machine, not your laptop.
For local development, start a tunnel to the API port and pass its origin:

```sh
bun sixb dev --api-port 3002 --api-public-origin https://your-tunnel.example.dev
```

The agent worker adds the API origin to the sandbox's network, installs the Sixb CLI and the run
context, runs `sixb status`, and destroys the sandbox after the run.

## Sandbox API

Use the factory directly when you need commands and files outside an agent run:

```ts
import { sandboxes } from "./sandbox"

const sandbox = await sandboxes.create()
try {
  await sandbox.writeFiles([
    { path: "hello.txt", contents: "Hello from Sixb\n" },
    { path: "scripts/run.sh", contents: "#!/bin/bash\ncat hello.txt\n", mode: 0o755 },
  ])

  const result = await sandbox.runCommand("bash", ["scripts/run.sh"], {
    env: { TASK_ID: "example" },
    timeout: 10_000,
  })
  console.log(result.exitCode, result.stdout, result.stderr)
} finally {
  await sandbox.destroy()
}
```

| Behavior | Contract |
| --- | --- |
| Isolation | Every machine is isolated: no peers on your organization's network, no boxd credentials inside |
| Command user | UID/GID 65534, no groups, no capabilities, no new privileges; it can't use `sudo` |
| Arguments | Literal argv; use `bash -c` explicitly for shell syntax |
| Environment | Factory → create → command; later values win; nothing else of the machine's environment |
| Working directory | `/workspace` by default, owned by the command user; `HOME` is `/var/lib/sixb-home` |
| Timeout | Exit `137`, `timedOut: true`, output written before the deadline kept |
| Cancellation | Exit `137` without `timedOut`; the command and everything it started are killed |
| Background processes | A process started with `setsid ... &` keeps running between commands |
| Files | UTF-8 or bytes, nested paths, overwrite and POSIX modes, written as the command user |
| `stop()` | Hibernates the machine, keeping memory and disk; the handle rejects further calls |
| `destroy()` | Deletes the machine; repeated calls share the outcome |

The default image is Ubuntu 24.04 with Bun, Node, Python, Git and curl. Commands run as an
unprivileged user, so `setup` can't install system packages. Prepare a
[snapshot](https://docs.boxd.sh/guides/snapshots?ref=sixb) with them instead and pass `snapshot`.

## Persistence

Conversation [sandbox bindings](../../docs/sandboxes/overview.md#keep-files-across-conversation-runs)
keep a thread's workspace between runs. On boxd that is one machine per thread, hibernated between
runs:

```ts
const sandbox = await sandboxes.create({ persistence: { name: "my-workspace" } })
await sandbox.writeFiles([{ path: "draft.txt", contents: "Work in progress" }])
await sandbox.stop()

const resumed = await sandboxes.resume("my-workspace")
await resumed.runCommand("cat", ["draft.txt"])
await resumed.stop()
```

- `stop()` first removes the session's request credentials and closes the machine's egress, then
  hibernates it. Files, installed packages and running processes are there on resume.
- `resume()` wakes the machine, applies the new session's network and credentials, and never runs
  `setup` again. It rejects a sandbox that is still running, and throws
  `SandboxStateUnavailableError` for a name with no machine.
- Creation never attaches to an existing name. A failed creation leaves the machine hibernated
  rather than deleting state another attempt may own.
- The machine is named after a digest of the sandbox name and labelled `sixb-sandbox=<name>`.
  Names are scoped to the API key's owner and organization; the caller serializes each name's
  lifecycle.
- `destroy()` deletes the machine and its state for good.

## Request credentials

The factory supports request credentials (`supportsRequestCredentials`), such as the run token the
agent worker adds to every call its commands make to the Sixb API. A forwarder runs as root in the
machine and holds them; `credentialedUrl(url)` is its socket under `/var/lib/sixb-forward`, which
forwards only to `url` and adds the credential that matches the request. The credentials reach the
machine through the file API into root-only files, never in a command's text, and commands run as
UID 65534, which cannot read them. Pass credentials to `create()` or `resume()`; a factory default
is refused. A credential's origin must be in the sandbox's network.

## Networking

```ts
// Default: no outbound network, including DNS.
const offline = await sandboxes.create({ network: { mode: "none" } })

// Only the listed hosts.
const restricted = await sandboxes.create({
  network: {
    mode: "restricted",
    allow: [{ name: "sixb-api", origin: "https://api.example.com" }],
  },
})

// Unrestricted outbound network.
const connected = await sandboxes.create({ network: { mode: "all" } })
```

| Policy | Behavior |
| --- | --- |
| `none` or restricted with `allow: []` | The machine reaches nothing, DNS included |
| `restricted` | Only the listed origins' hosts; other names don't resolve |
| `all` | Unrestricted outbound network |

The policy is part of the machine's spec from its first boot, and each resume applies the new
session's policy. A boxd machine runs remotely, so loopback and private addresses are refused:
allow a public origin instead.

## Configuration

| Factory option | Default / requirement |
| --- | --- |
| `apiKey` | `BOXD_API_KEY` |
| `org` | The API key's organization, or personal machines |
| `region` | The API's default region; `fra` or `nyc` |
| `size` | The organization's default; `1x4`, `2x8`, `4x16` or `8x32` (vCPU x GiB) |
| `snapshot` | The default image; a snapshot needs `sudo`, `setpriv` and Bun or Node |
| `namePrefix` | `sixb-` |
| `labels` | None; added to every machine |
| `workingDirectory` | `/workspace` |
| `env` | No caller-supplied values |
| `network` | `{ mode: "none" }` |
| `timeout` | No per-command timeout |
| `readyTimeoutMs` | `120_000` ms for a new or resumed machine to accept commands |
| `setupTimeoutMs` | `60_000` ms for each of the provider's own steps, such as installing credentials |
| `baseURL` | Production |

`create()` and `resume()` can override `workingDirectory`, `env`, `network` and `timeout`.

> **Cleanup:** always call `destroy()` for ephemeral work. A machine left behind hibernates after
> its idle timeout and stays until you delete it. Set `labels` to find your workers' machines.

## Development and tests

<details>
<summary>Commands for contributors working in the Sixb repository</summary>

```sh
bun test sandboxes/boxd/tests/
```

Live tests create real machines with the key in `BOXD_API_KEY`, and destroy them. `BOXD_ORG`
and `BOXD_REGION` select the organization and region:

```sh
SIXB_BOXD_E2E=1 bun test --timeout 300000 \
  ./sandboxes/boxd/tests/sandbox.e2e.ts \
  ./sandboxes/boxd/tests/persistence.e2e.ts
```

The request credentials suite and the agent runtime test need public HTTPS origins that forward to
a local port, such as tunnels:

```sh
SIXB_BOXD_E2E=1 \
SIXB_BOXD_CREDENTIALS_ORIGINS=https://a.example.dev,https://b.example.dev \
SIXB_BOXD_CREDENTIALS_PORT=8000 \
bun test --timeout 300000 ./sandboxes/boxd/tests/credentials.e2e.ts

SIXB_BOXD_E2E=1 SIXB_BOXD_AGENT_ORIGIN=https://a.example.dev SIXB_BOXD_AGENT_PORT=8000 \
bun test --timeout 300000 ./sandboxes/boxd/tests/agent-runtime.e2e.ts
```

The agent test uses a deterministic model, synthetic data and the real worker, CLI and run-token
API. It answers only run-token requests on the public origin.

</details>
