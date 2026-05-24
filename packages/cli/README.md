# @pario/cli

Command-line interface for building and running [Pario](https://github.com/demattosanthony/pario) digital twin projects. All commands expect a `pario.config.ts` in the current directory unless `--entry` is specified.

## Installation

```bash
bun add @pario/cli
```

## Commands

| Command | Description |
|---|---|
| `pario dev` | Start local API, Atlas UI, and optional custom app servers |
| `pario worker` | Start the dedicated worker runtime |
| `pario check` | Validate project configuration and provider health |
| `pario build` | Bundle the project for production, including any custom app |
| `pario start` | Start production API, Atlas UI, and any built custom app servers |
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
| `--port <port>` | `dev`, `start` | `3000` | Atlas UI port. The custom app defaults to `port + 1`. |
| `--host <host>` | `dev`, `start` | `0.0.0.0` | Browser app bind host |
| `--api-port <port>` | `dev`, `start` | `port + 2` | API/auth/docs/WebSocket port |
| `--api-host <host>` | `dev`, `start` | `--host` | API bind host |
| `--api-public-origin <origin>` | `dev`, `start` | dev: `http://localhost:<api-port>` | Public API origin |
| `--atlas-public-origin <origin>` | `dev`, `start` | dev: `http://localhost:<port>` | Public Atlas UI origin |
| `--app-public-origin <origin>` | `dev`, `start` | dev: `http://localhost:<port+1>` | Public custom app origin |
| `--worker <type>` | `worker` | auto | Worker type: `sync`, `action`, `pipeline`, `projection`, or `workflow` |
| `--outdir <path>` | `build` | `.pario/dist` | Build output directory |

## Usage

```bash
# Start development servers (loads ./pario.config.ts)
pario dev

# Start the dedicated worker runtime for all registered worker types
pario worker

# Start only pipeline workers
pario worker --worker pipeline

# Start only the workflow queue consumer
pario worker --worker workflow

# Development with custom entry and Atlas port
pario dev --entry examples/mac-os/pario.config.ts --port 8080

# Validate project health
pario check

# Run storage migrations
pario db migrate

# Build for production, then start the built server and custom app
pario build
pario start

# Scaffold a new project
pario create my-project
cd my-project && bun install && pario dev

# Initialize pario in an existing directory
pario init .
```

`pario dev` and `pario start` automatically run adapter migrations before serving traffic when the configured adapters expose migration support.

`pario dev` uses separated local ports by default:

```txt
http://localhost:3000 -> Atlas UI
http://localhost:3001 -> custom app UI when routes exist
http://localhost:3002 -> API, auth, docs, and runtime WebSockets
```

`pario start` requires explicit production public origins through flags or environment variables:
`PARIO_API_PUBLIC_ORIGIN`, `PARIO_ATLAS_PUBLIC_ORIGIN`, and `PARIO_APP_PUBLIC_ORIGIN` when a built
custom app is served.

`pario worker` is intended for queue backends that can be shared across processes. Without
`--worker`, it starts the workers that match registered definitions. With the built-in
`InMemoryQueues`, use `pario dev`, which co-hosts workers in-process.
