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
| `pario worker <type>` | Start a production queue worker |
| `pario check` | Validate project configuration and provider health |
| `pario build` | Bundle the project runtime, custom app, Atlas assets, and Sentinel assets |
| `pario start` | Start a local production role supervisor |
| `pario db migrate` | Run adapter-owned database migrations for the configured storage |
| `pario init [dir]` | Initialize a new pario project in a directory |
| `pario create <name>` | Scaffold a new pario project from the built-in template |
| `pario help` | Show help |
| `pario --version` | Show version |

Also available as `create-pario <name>` (alias for `pario create`).

## Options

| Flag | Applies to | Default | Description |
|---|---|---|---|
| `--entry <path>` | all | `pario.config.ts` | Path to the pario config module |
| `--port <port>` | serving commands | role default | Role bind port. For `dev`/`start`, this is the Atlas base port. |
| `--host <host>` | browser serving commands | `0.0.0.0` | Browser app bind host |
| `--api-port <port>` | `dev`, `start`, `api` | `port + 2` | API/auth/docs/WebSocket port |
| `--api-host <host>` | `dev`, `start`, `api` | `--host` | API bind host |
| `--api-public-origin <origin>` | browser/API commands | dev: `http://localhost:<api-port>` | Public API origin |
| `--atlas-public-origin <origin>` | `dev`, `start`, `api`, `atlas` | dev: `http://localhost:<port>` | Public Atlas UI origin |
| `--sentinel-public-origin <origin>` | `dev`, `start`, `api`, `sentinel` | dev: `http://localhost:<port+3>` | Public Sentinel UI origin |
| `--app-public-origin <origin>` | `dev`, `start`, `api`, `app` | dev: `http://localhost:<port+1>` | Public custom app origin |
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

# Convenience supervisor that starts the production roles as child processes
pario start

# Scaffold a new project
pario create my-project
cd my-project && bun install && pario dev

# Initialize pario in an existing directory
pario init .
```

`pario dev` remains the local all-in-one command. Production deployments should prefer one long-running command per process so API, browser UIs, scheduler, orchestrator, functions, rules, and queue workers can scale and fail independently.

`pario start` is a local or single-node convenience supervisor. It starts the same production role
commands as child processes and shuts them down together, but each role still runs in its own OS
process. Use the individual role commands with Docker, Kubernetes, systemd, or other process
managers.

`pario api`, worker/runtime role commands, and `pario dev` run adapter migrations and lake
definition compatibility checks before starting their role when the configured adapters expose
migration support. `pario start` relies on those child role commands for the same checks.

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
worker process owns exactly one queue type. With the built-in `InMemoryQueues`, use `pario dev`,
which co-hosts workers in-process.
