# @sixb/cli

Command-line interface for building and running [Sixb](https://github.com/sixb-ai/sixb) digital twin projects. All commands expect a `sixb.config.ts` in the current directory unless `--entry` is specified.

## Installation

```bash
bun add @sixb/cli
```

## Commands

| Command | Description |
|---|---|
| `sixb dev` | Start local API, Atlas UI, Sentinel UI, optional custom app, and workers |
| `sixb api` | Start the production API/docs/WebSocket server |
| `sixb atlas` | Start the production Atlas UI server |
| `sixb sentinel` | Start the production Sentinel UI server |
| `sixb app` | Start the production custom app server |
| `sixb scheduler` | Start the production scheduler event producer |
| `sixb orchestrator` | Start the production event-to-queue dispatcher |
| `sixb functions` | Start registered functions |
| `sixb rules` | Start rules evaluation |
| `sixb worker <type>` | Start a production queue worker (one queue type per process) |
| `sixb worker-group [types...]` | Co-host several queue workers in one process (constrained resources) |
| `sixb check` | Validate project configuration and provider health |
| `sixb build` | Bundle the project runtime, custom app, Atlas assets, and Sentinel assets |
| `sixb db migrate` | Run adapter-owned database migrations for the configured storage |
| `sixb lake check` | Check lake dataset definitions for drift against the lake catalog |
| `sixb lake cleanup` | Run provider-supported lake maintenance cleanup |
| `sixb init [dir]` | Initialize a new sixb project in a directory |
| `sixb create <name>` | Scaffold a new sixb project from the built-in template |
| `sixb help` | Show help |
| `sixb --version` | Show version |

Also available as `create-sixb <name>` (alias for `sixb create`).

## Options

| Flag | Applies to | Default | Description |
|---|---|---|---|
| `--entry <path>` | all | `sixb.config.ts` | Path to the sixb config module |
| `--port <port>` | serving commands | role default | Role bind port. For `dev`, this is the Atlas base port. |
| `--host <host>` | browser serving commands | `0.0.0.0` | Browser app bind host |
| `--api-port <port>` | `dev`, `api` | `port + 2` | API/auth/docs/WebSocket port |
| `--api-host <host>` | `dev`, `api` | `--host` | API bind host |
| `--api-public-origin <origin>` | browser/API commands | dev: `http://localhost:<api-port>` | Public API origin |
| `--atlas-public-origin <origin>` | `dev`, `api`, `atlas` | dev: `http://localhost:<port>` | Public Atlas UI origin |
| `--sentinel-public-origin <origin>` | `dev`, `api`, `sentinel` | dev: `http://localhost:<port+3>` | Public Sentinel UI origin |
| `--app-public-origin <origin>` | `dev`, `api`, `app` | dev: `http://localhost:<port+1>` | Public custom app origin |
| `--outdir <path>` | `build` | `.sixb/dist` | Build output directory |
| `--dry-run` | `lake cleanup` | false | Preview cleanup without changing storage |
| `--expire-older-than <interval>` | `lake cleanup` | `7 days` | Snapshot expiration window |
| `--delete-older-than <interval>` | `lake cleanup` | expire window | File deletion window |

## Usage

```bash
# Start development servers (loads ./sixb.config.ts)
sixb dev

# Build production runtime and static UI/app assets
sixb build

# Recommended production process layout
sixb api
sixb atlas
sixb sentinel
sixb app
sixb scheduler
sixb orchestrator
sixb functions
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

# Scaffold a new project
sixb create my-project
cd my-project && bun install && sixb dev

# Initialize sixb in an existing directory
sixb init .
```

`sixb dev` remains the local all-in-one command. Production deployments should prefer one long-running command per process so API, browser UIs, scheduler, orchestrator, functions, rules, and queue workers can scale and fail independently.

### Release order

Run deployment checks as explicit release steps, then start the services. This keeps service
startup cheap and role-local: roles no longer open the lake catalog at boot, so starting every
process at once (e.g. with PM2) does not stampede a Postgres-backed DuckLake catalog.

```bash
sixb build        # bundle runtime and UI/app assets
sixb db migrate   # run adapter-owned storage migrations
sixb lake check   # verify lake dataset definitions are compatible with the catalog
pm2 start ecosystem.config.cjs
```

`sixb lake check` is the single place that attaches the lake and validates every dataset
definition during deploy. Service commands (`api`, `scheduler`, `orchestrator`, `functions`,
`rules`, `worker`, `worker-group`) no longer run lake checks or storage migrations at startup, so
starting them together does not stampede shared infrastructure. Run `sixb db migrate` as a
required release step before starting roles — `sixb dev` still migrates in-process for local use.

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
process.

`sixb dev` uses separated local ports by default:

```txt
http://localhost:3000 -> Atlas UI
http://localhost:3001 -> custom app UI when routes exist
http://localhost:3002 -> API, auth, docs, and runtime WebSockets
```

Production serving commands require explicit public origins through flags or environment variables.
The split UI commands require their own public origin and `SIXB_API_PUBLIC_ORIGIN`. `sixb api`
requires `SIXB_API_PUBLIC_ORIGIN`, `SIXB_ATLAS_PUBLIC_ORIGIN`,
`SIXB_SENTINEL_PUBLIC_ORIGIN`, and `SIXB_APP_PUBLIC_ORIGIN` when a built custom app is served.

`sixb atlas`, `sixb sentinel`, and `sixb app` serve only prebuilt assets. Run `sixb build`
before starting them. They fail with a clear error instead of compiling assets at startup.

`sixb worker <type>` is intended for queue backends that can be shared across processes. Each
worker process owns exactly one queue type. `sixb worker-group [types...]` co-hosts several queue
workers in a single process for constrained deployments; with no positional types it starts every
registered worker type. Both reject the built-in `InMemoryQueues` — use `sixb dev`, which co-hosts
workers in-process.
