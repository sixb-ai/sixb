# @pario/cli

Command-line interface for building and running [Pario](https://github.com/demattosanthony/pario) digital twin projects. All commands expect a `pario.config.ts` in the current directory unless `--entry` is specified.

## Installation

```bash
bun add @pario/cli
```

## Commands

| Command | Description |
|---|---|
| `pario dev` | Start development server with the built-in UI, API, and optional custom app |
| `pario worker` | Start the dedicated worker runtime |
| `pario check` | Validate project configuration and provider health |
| `pario build` | Bundle the project for production, including any custom app |
| `pario start` | Start the production server and any built custom app |
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
| `--port <port>` | `dev`, `start` | `3000` | HTTP server port |
| `--host <host>` | `dev`, `start` | `0.0.0.0` | HTTP server host |
| `--worker <type>` | `worker` | auto | Worker type: `sync`, `action`, `pipeline`, `projection`, or `workflow` |
| `--outdir <path>` | `build` | `.pario/dist` | Build output directory |

## Usage

```bash
# Start development server (loads ./pario.config.ts, port 3000)
pario dev

# Start the dedicated worker runtime for all registered worker types
pario worker

# Start only pipeline workers
pario worker --worker pipeline

# Start only the workflow queue consumer
pario worker --worker workflow

# Development with custom entry and port
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

`pario worker` is intended for queue backends that can be shared across processes. Without
`--worker`, it starts the workers that match registered definitions. With the built-in
`InMemoryQueues`, use `pario dev`, which co-hosts workers in-process.
