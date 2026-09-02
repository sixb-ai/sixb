# @sixb/cli

Command-line interface for building and running [Sixb](https://github.com/sixb-ai/sixb) digital twin projects. All commands expect a `sixb.config.ts` in the current directory unless `--entry` is specified.

## Installation

Install the `sixb` cli globally:

```bash
bun add --global @sixb/cli
sixb --version
```

Add the CLI to a Sixb project when its development and deployment scripts use it:

```bash
bun add @sixb/cli
```

## Commands

| Command | Description |
|---|---|
| `sixb dev` | Start local API, Atlas UI, optional custom app, and workers |
| `sixb api` | Start the production API/docs/WebSocket server |
| `sixb atlas` | Start the production Atlas UI server |
| `sixb app` | Start the production custom app server |
| `sixb login <api-url>` | Validate an instance and save it as the current profile |
| `sixb logout` | Remove the current or named profile |
| `sixb status` | Check the selected profile and API |
| `sixb profile list` | List saved profiles |
| `sixb profile show [name]` | Show a profile without exposing its token |
| `sixb profile use <name>` | Select the current profile |
| `sixb project show` | Show project metadata |
| `sixb ontology list|get` | Inspect the visible ontology |
| `sixb objects ...` | Inspect, list, search, and query objects |
| `sixb telemetry ...` | Read current and historical telemetry |
| `sixb actions ...` | Discover and request actions |
| `sixb action-runs ...` | Inspect action execution history |
| `sixb workflows ...` | Discover and start workflows |
| `sixb workflow-runs ...` | Inspect workflow execution history |
| `sixb files ...` | Upload and download files |
| `sixb token list` | List personal access tokens |
| `sixb token create` | Create a personal access token |
| `sixb token revoke <id>` | Revoke a personal access token |
| `sixb service-account list` | List service accounts |
| `sixb service-account create` | Create a service account |
| `sixb service-account disable <id>` | Disable a service account |
| `sixb service-account token list <service-account-id>` | List service-account tokens |
| `sixb service-account token create <service-account-id>` | Create a service-account token |
| `sixb service-account token revoke <service-account-id> <token-id>` | Revoke a service-account token |
| `sixb scheduler` | Start the production scheduler event producer |
| `sixb orchestrator` | Start the production event-to-queue dispatcher |
| `sixb rules` | Start rules evaluation |
| `sixb worker <type>` | Start a production queue worker (one queue type per process) |
| `sixb worker-group [types...]` | Co-host several queue workers in one process (constrained resources) |
| `sixb check` | Validate project configuration and provider health |
| `sixb build` | Bundle the project runtime, custom app, and Atlas assets |
| `sixb db migrate` | Run adapter-owned database migrations ahead of, or instead of, role startup |
| `sixb lake check` | Check lake dataset definitions for drift against the lake catalog |
| `sixb lake cleanup` | Run provider-supported lake maintenance cleanup |
| `sixb init [dir]` | Initialize a new sixb project in a directory |
| `sixb help` | Show help |
| `sixb --version` | Show version |

Scaffold a new project without installing the CLI first with `bun create sixb <name>`.

## Options

| Flag | Applies to | Default | Description |
|---|---|---|---|
| `--entry <path>` | project and runtime commands | `sixb.config.ts` | Path to the sixb config module |
| `--no-migrate` | production roles | false | Start without migrating storage. Also `SIXB_SKIP_MIGRATION=1`. |
| `--port <port>` | serving commands | role default | Role bind port. For `dev`, this is the Atlas base port. |
| `--host <host>` | serving commands | dev: `127.0.0.1`, roles: `0.0.0.0` | Bind host. `sixb dev` stays on loopback unless you opt in. |
| `--api-port <port>` | `dev`, `api` | `port + 2` | API/auth/docs/WebSocket port |
| `--api-host <host>` | `dev`, `api` | `--host` | API bind host |
| `--api-public-origin <origin>` | browser/API commands | dev: `http://localhost:<api-port>` | Public API origin |
| `--agent-turn-timeout <duration>` | `dev`, agent worker/group | `SIXB_AGENT_TURN_TIMEOUT` or `10m` | Agent turn wall-clock budget, e.g. `30s`, `10m`, or `1h` |
| `--atlas-public-origin <origin>` | `dev`, `api`, `atlas` | dev: `http://localhost:<port>` | Public Atlas UI origin |
| `--app-public-origin <origin>` | `dev`, `api`, `app` | dev: `http://localhost:<port+1>` | Public custom app origin |
| `--profile <name>` | remote commands | current profile | Use a saved profile without changing the current one |
| `--api-url <url>` | remote commands | resolved profile or `http://localhost:3002` | Use an API without a saved profile |
| `--token <token>` | remote commands | selected source | Bearer token; direct `--api-url` never inherits another source's token |
| `--token-stdin` | `login` | false | Read an existing token from standard input |
| `--id <id>` | token/service-account commands | generated when supported | Token or service-account id |
| `--name <name>` | token/service-account commands | required for create | Token or service-account name |
| `--description <text>` | `service-account create` | none | Service-account description |
| `--expires-in <duration>` | token create commands | `90d` | Token lifetime, e.g. `30d`, `4w`, or `1y` |
| `--expires-at <iso>` | token create commands | none | Token expiration timestamp |
| `--group <id>` | token/service-account create commands | inherited/none | Assignable auth group; may repeat or use commas |
| `--json` | profile and credential commands | false | Print machine-readable JSON |
| `--outdir <path>` | `build` | `.sixb/dist` | Build output directory |
| `--dry-run` | `lake cleanup` | false | Preview cleanup without changing storage |
| `--expire-older-than <interval>` | `lake cleanup` | `7 days` | Snapshot expiration window |
| `--delete-older-than <interval>` | `lake cleanup` | expire window | File deletion window |

Options are command-scoped. Unknown options, missing values, duplicate scalar options, and extra
positionals fail before the command runs. Repeatable options such as `--group` and the typed
`--concurrency` forms are declared explicitly. `--api-url` and `--profile` are mutually exclusive;
either may be paired with an explicit `--token`.

Use either help form for contextual command documentation:

```bash
sixb token --help
sixb help token create
```

A bare command group prints its scoped help without choosing a default action:

```bash
sixb profile
sixb service-account token
```

## Output and exit codes

Instance commands emit compact JSON by default. Profile and credential-management commands render
for humans by default and emit compact JSON when passed `--json`. In JSON mode, failures are
written as one compact `{"error": ...}` value on stderr.

```text
0  success or help
1  command or runtime failure
2  invalid arguments
3  API failure
```

## Usage

```bash
# Start development servers (loads ./sixb.config.ts)
sixb dev

# Build production runtime and static UI/app assets
sixb build

# Recommended production process layout
sixb api
sixb atlas
sixb app
sixb scheduler
sixb orchestrator
sixb rules
sixb worker sync
sixb worker pipeline
sixb worker projection
sixb worker action
sixb worker workflow

# Development with custom entry and Atlas port
sixb dev --entry examples/mac-os/sixb.config.ts --port 8080

# Validate project health
sixb check

# Run storage migrations
sixb db migrate

# Check lake dataset definitions for drift during deploy
sixb lake check

# Preview or run lake maintenance cleanup
sixb lake cleanup --dry-run
sixb lake cleanup --expire-older-than "1 hour" --delete-older-than "1 hour"
sixb lake cleanup --expire-older-than "7 days" --delete-older-than "7 days"

# Scaffold a new project without installing the CLI
bun create sixb my-project
cd my-project && bun install && sixb dev

# Initialize sixb in an existing directory
sixb init .
```

## Profiles and remote commands

Login validates `/api/project`, saves the profile in `~/.config/sixb/config.json`, and selects it.
The directory is mode `0700`; the config file is atomically replaced at mode `0600`.

```bash
sixb login http://localhost:3002 --profile local

# For an API that requires an existing token:
printf '%s\n' "$SIXB_API_TOKEN" |
  sixb login https://api.acme.example --profile production --token-stdin

sixb status
sixb profile list
sixb profile use production
sixb ontology list
sixb objects inspect Customer customer-123
```

An auth-disabled local API stores a tokenless profile. If authentication is required and
`--token-stdin` is omitted, `sixb login` prompts for the token without echoing it. Browser login is
planned separately.

Remote target resolution is deterministic:

```text
--api-url (+ optional --token)
--profile (+ optional --token)
SIXB_API_URL (+ SIXB_API_TOKEN or SIXB_TOKEN)
SIXB_PROFILE
current profile
http://localhost:3002
```

Use a named profile for local tools such as Codex or Claude Code:

```bash
sixb objects search "Northline" --profile production
SIXB_PROFILE=production sixb project show
```

CI can keep credentials entirely in the environment:

```bash
SIXB_API_URL=https://api.acme.example \
SIXB_API_TOKEN=sixb_sat_... \
sixb objects list
```

## API credential management

Personal access tokens are user-owned credentials. They can manage personal tokens, service
accounts, and service-account tokens within the caller's existing groups and permissions.

```bash
sixb token list
sixb token create --name "Local CLI" --expires-in 90d --group agents
sixb token revoke tok_...
```

Service accounts are machine identities for agents, sandboxes, deploy jobs, and external systems.
Create the service account first, then mint one or more service-account tokens for it.

```bash
sixb service-account list
sixb service-account create \
  --id svc_sandbox \
  --name "Sandbox agent" \
  --description "Used by sandboxed agents" \
  --group agents

sixb service-account token list svc_sandbox
sixb service-account token create svc_sandbox \
  --name "Sandbox token" \
  --expires-in 30d \
  --group agents
sixb service-account token revoke svc_sandbox tok_...
sixb service-account disable svc_sandbox
```

Use `--json` on profile and credential-management commands when scripting:

```bash
sixb service-account token create svc_sandbox --name "CI token" --expires-in 30d --json
```

Service-account tokens are runtime credentials. They can authenticate API requests that accept
bearer tokens, but they cannot manage personal tokens, service accounts, or mint more credentials.

`sixb dev` remains the local all-in-one command. Production deployments should prefer one long-running command per process so API, browser UIs, scheduler, orchestrator, rules, and queue workers can scale and fail independently.

### Release order

Run deployment checks as explicit release steps, then start the services. This keeps service
startup cheap and role-local: roles no longer open the lake catalog at boot, so starting every
process at once (e.g. with PM2) does not stampede a Postgres-backed DuckLake catalog.

```bash
sixb build        # bundle runtime and UI/app assets
sixb check        # probe the configured providers and the storage schema
sixb lake check   # verify lake dataset definitions are compatible with the catalog
pm2 start ecosystem.config.cjs
```

`sixb lake check` is the single place that attaches the lake and validates every dataset
definition during deploy. Service commands (`api`, `scheduler`, `orchestrator`, `rules`, `worker`,
`worker-group`) do not open the lake catalog at startup, so starting them together does not
stampede shared infrastructure.

`sixb check` exits non-zero when a probe fails, so it works as a deploy gate. It opens a read-only
round trip to the storage, its telemetry table, and the broker, reads the storage schema state
without touching it, and warns when the broker or queues provider only works inside one process —
the configuration that makes a production role refuse to start. Each probe is bounded at five
seconds, so an unreachable host is reported rather than waited on. The queues provider is named but
not probed: every operation in that contract claims or enqueues work, so there is nothing read-only
to call.

### Storage migrations

Roles that read or write through the storage schema (`api`, `scheduler`, `orchestrator`, `rules`,
`worker`, `worker-group`) bring it up to date themselves at startup, and print the migration steps
they applied. `atlas` and `app` do not: they serve a browser bundle and hold no DDL grant.

`sixb db migrate` is no longer a required release step. It stays useful when you want the schema
change to be its own deploy stage — run it first, then start the roles with `--no-migrate` (or
`SIXB_SKIP_MIGRATION=1`), which reports the skip instead of staying silent about it.

Concurrent replicas are safe on Postgres: migrators serialize on a session advisory lock, so late
starters find the schema current and no-op. Every adapter also refuses to run against a history it
does not recognize — a changed checksum, a version newer than the build, an interrupted run — and
names the condition instead of migrating over it. SQLite has no cross-process lock, so roles
starting together on one file can collide; migrate it as its own step and pass `--no-migrate`.

The lake is opened only when a role actually does lake work — API dataset routes, sync jobs,
pipeline jobs, and projection jobs. Write paths re-validate their target dataset through the lake
provider's `createDataset` before committing, so drift still fails clearly even between deploys.

Use `sixb lake cleanup` for operator-run lake maintenance on providers that expose
`runMaintenance`. It defaults to a seven-day snapshot expiration and file deletion window. Start
with `--dry-run` to preview how many snapshots and files DuckLake reports as eligible.

### Production topologies

Both layouts are valid; choose based on the deployment's Postgres/DuckLake connection budget.

**Scaled** — one process per queue type, each independently scalable with its own lake pool:

```bash
sixb api
sixb scheduler
sixb orchestrator
sixb worker sync
sixb worker pipeline
sixb worker projection
SIXB_API_PUBLIC_ORIGIN=https://api.example.com sixb worker agent
```

**Constrained** — co-host the queue workers in one process to shrink the provider footprint
(one lake pool instead of one per worker), trading per-worker event-loop isolation:

```bash
sixb api
sixb scheduler
sixb orchestrator
sixb worker-group sync pipeline projection
```

`sixb worker-group` with no positional types starts every registered queue worker type in one
process, including the agent worker when agents and agent storage are configured. Agent workers
require the API origin through `--api-public-origin` or `SIXB_API_PUBLIC_ORIGIN`. Set the per-turn
wall-clock budget with `--agent-turn-timeout` or `SIXB_AGENT_TURN_TIMEOUT`; it defaults to 10 minutes.

`sixb dev` uses separated local ports by default:

```txt
http://localhost:3000 -> Atlas UI
http://localhost:3001 -> custom app UI when routes exist
http://localhost:3002 -> API, auth, docs, and runtime WebSockets
```

Production serving commands require explicit public origins through flags or environment variables.
The split UI commands require their own public origin and `SIXB_API_PUBLIC_ORIGIN`. `sixb api`
requires `SIXB_API_PUBLIC_ORIGIN`, `SIXB_ATLAS_PUBLIC_ORIGIN`,
and `SIXB_APP_PUBLIC_ORIGIN` when a built custom app is served.

`sixb atlas` and `sixb app` serve only prebuilt assets. Run `sixb build` before starting them.
They fail with a clear error instead of compiling assets at startup.

`sixb worker <type>` is intended for queue backends that can be shared across processes. Each
worker process owns exactly one queue type. `sixb worker-group [types...]` co-hosts several queue
workers in a single process for constrained deployments; with no positional types it starts every
registered worker type. Agent workers require `--api-public-origin` or
`SIXB_API_PUBLIC_ORIGIN`. Their turn budget can be set with `--agent-turn-timeout` or
`SIXB_AGENT_TURN_TIMEOUT`. Both commands reject the built-in `InMemoryQueues` — use `sixb dev`,
which co-hosts workers in-process.
