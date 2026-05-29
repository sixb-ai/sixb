# @pario/cli

Command-line interface for building and running [Pario](https://github.com/demattosanthony/pario) digital twin projects. All commands expect a `pario.config.ts` in the current directory unless `--entry` is specified.

## Installation

```bash
bun add @pario/cli
```

## Commands

| Command | Description |
|---|---|
| `pario dev` | Start local API, Atlas UI, Sentinel UI, optional custom app, and workers |
| `pario api` | Start the production API/docs/WebSocket server |
| `pario atlas` | Start the production Atlas UI server |
| `pario sentinel` | Start the production Sentinel UI server |
| `pario app` | Start the production custom app server |
| `pario scheduler` | Start the production scheduler event producer |
| `pario orchestrator` | Start the production event-to-queue dispatcher |
| `pario functions` | Start registered functions |
| `pario rules` | Start rules evaluation |
| `pario worker <type>` | Start a production queue worker (one queue type per process) |
| `pario worker-group [types...]` | Co-host several queue workers in one process (constrained resources) |
| `pario check` | Validate project configuration and provider health |
| `pario build` | Bundle the project runtime, custom app, Atlas assets, and Sentinel assets |
| `pario db migrate` | Run adapter-owned database migrations for the configured storage |
| `pario lake check` | Check lake dataset definitions for drift against the lake catalog |
| `pario init [dir]` | Initialize a new pario project in a directory |
| `pario create <name>` | Scaffold a new pario project from the built-in template |
| `pario help` | Show help |
| `pario --version` | Show version |

Also available as `create-pario <name>` (alias for `pario create`).

## Options

| Flag | Applies to | Default | Description |
|---|---|---|---|
| `--entry <path>` | all | `pario.config.ts` | Path to the pario config module |
| `--port <port>` | serving commands | role default | Role bind port. For `dev`, this is the Atlas base port. |
| `--host <host>` | browser serving commands | `0.0.0.0` | Browser app bind host |
| `--api-port <port>` | `dev`, `api` | `port + 2` | API/auth/docs/WebSocket port |
| `--api-host <host>` | `dev`, `api` | `--host` | API bind host |
| `--api-public-origin <origin>` | browser/API commands | dev: `http://localhost:<api-port>` | Public API origin |
| `--atlas-public-origin <origin>` | `dev`, `api`, `atlas` | dev: `http://localhost:<port>` | Public Atlas UI origin |
| `--sentinel-public-origin <origin>` | `dev`, `api`, `sentinel` | dev: `http://localhost:<port+3>` | Public Sentinel UI origin |
| `--app-public-origin <origin>` | `dev`, `api`, `app` | dev: `http://localhost:<port+1>` | Public custom app origin |
| `--outdir <path>` | `build` | `.pario/dist` | Build output directory |

## Usage

```bash
# Start development servers (loads ./pario.config.ts)
pario dev

# Build production runtime and static UI/app assets
pario build

# Recommended production process layout
pario api
pario atlas
pario sentinel
pario app
pario scheduler
pario orchestrator
pario functions
pario rules
pario worker sync
pario worker pipeline
pario worker projection
pario worker action
pario worker workflow

# Development with custom entry and Atlas port
pario dev --entry examples/mac-os/pario.config.ts --port 8080

# Validate project health
pario check

# Run storage migrations
pario db migrate

# Check lake dataset definitions for drift during deploy
pario lake check

# Scaffold a new project
pario create my-project
cd my-project && bun install && pario dev

# Initialize pario in an existing directory
pario init .
```

`pario dev` remains the local all-in-one command. Production deployments should prefer one long-running command per process so API, browser UIs, scheduler, orchestrator, functions, rules, and queue workers can scale and fail independently.

### Release order

Run deployment checks as explicit release steps, then start the services. This keeps service
startup cheap and role-local: roles no longer open the lake catalog at boot, so starting every
process at once (e.g. with PM2) does not stampede a Postgres-backed DuckLake catalog.

```bash
pario build        # bundle runtime and UI/app assets
pario db migrate   # run adapter-owned storage migrations
pario lake check   # verify lake dataset definitions are compatible with the catalog
pm2 start ecosystem.config.cjs
```

`pario lake check` is the single place that attaches the lake and validates every dataset
definition during deploy. Service commands (`api`, `scheduler`, `orchestrator`, `functions`,
`rules`, `worker`, `worker-group`) no longer run lake checks or storage migrations at startup, so
starting them together does not stampede shared infrastructure. Run `pario db migrate` as a
required release step before starting roles — `pario dev` still migrates in-process for local use.

The lake is opened only when a role actually does lake work — API dataset routes, sync jobs,
pipeline jobs, and projection jobs. Write paths re-validate their target dataset through the lake
provider's `createDataset` before committing, so drift still fails clearly even between deploys.

### Production topologies

Both layouts are valid; choose based on the deployment's Postgres/DuckLake connection budget.

**Scaled** — one process per queue type, each independently scalable with its own lake pool:

```bash
pario api
pario scheduler
pario orchestrator
pario worker sync
pario worker pipeline
pario worker projection
```

**Constrained** — co-host the queue workers in one process to shrink the provider footprint
(one lake pool instead of one per worker), trading per-worker event-loop isolation:

```bash
pario api
pario scheduler
pario orchestrator
pario worker-group sync pipeline projection
```

`pario worker-group` with no positional types starts every registered queue worker type in one
process.

`pario dev` uses separated local ports by default:

```txt
http://localhost:3000 -> Atlas UI
http://localhost:3001 -> custom app UI when routes exist
http://localhost:3002 -> API, auth, docs, and runtime WebSockets
```

Production serving commands require explicit public origins through flags or environment variables.
The split UI commands require their own public origin and `PARIO_API_PUBLIC_ORIGIN`. `pario api`
requires `PARIO_API_PUBLIC_ORIGIN`, `PARIO_ATLAS_PUBLIC_ORIGIN`,
`PARIO_SENTINEL_PUBLIC_ORIGIN`, and `PARIO_APP_PUBLIC_ORIGIN` when a built custom app is served.

`pario atlas`, `pario sentinel`, and `pario app` serve only prebuilt assets. Run `pario build`
before starting them. They fail with a clear error instead of compiling assets at startup.

`pario worker <type>` is intended for queue backends that can be shared across processes. Each
worker process owns exactly one queue type. `pario worker-group [types...]` co-hosts several queue
workers in a single process for constrained deployments; with no positional types it starts every
registered worker type. Both reject the built-in `InMemoryQueues` — use `pario dev`, which co-hosts
workers in-process.
