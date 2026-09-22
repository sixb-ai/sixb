# CLI

The Sixb CLI creates, runs, and builds projects. It can also connect to a running API to query data and run operations.

Inside a project, use `bun sixb`. To use `sixb` directly from anywhere, install the CLI:

```bash
bun add --global @sixb/cli
```

Use `sixb <command> --help` for command-specific arguments and options.

## Project commands

Run these from your project root:

| Command | Purpose |
| --- | --- |
| `bun create sixb my-app` | Create a new project. |
| `sixb init [directory]` | Initialize a project in a directory. |
| `sixb dev` | Start local API, Atlas, app, and workers. |
| `sixb build` | Build the runtime and browser assets into `.sixb/dist`. |
| `sixb typegen` | Generate ontology types for client queries. |
| `sixb check` | Validate the project and check provider health. |
| `sixb db migrate` | Apply storage migrations. |
| `sixb lake check` | Validate dataset definitions against the lake catalog. |
| `sixb lake cleanup --dry-run` | Preview supported lake maintenance. |

`dev` defaults to Atlas on port 3000, the custom app on 3001, and the API on 3002. Backend changes restart the local stack; app changes use hot reload. Restart manually after changing environment variables.

Common project options:

| Option | Purpose |
| --- | --- |
| `--entry <path>` | Use a different configuration file. |
| `--port <port>` | Set a serving command's port; for `dev`, the Atlas base port. |
| `--host <host>` | Bind host. Development defaults to loopback. |
| `--api-port <port>` | Set the development API port. |
| `--outdir <path>` | Change the build output directory. |

## Production services

Each command runs one service. See [Deployment](../deployment/overview.md) for the complete setup.

| Command | Purpose |
| --- | --- |
| `sixb api` | HTTP API, WebSockets, and OpenAPI docs. |
| `sixb atlas` | Built-in Atlas interface. |
| `sixb app` | Custom app. |
| `sixb orchestrator` | Dispatch event-triggered work. |
| `sixb scheduler` | Trigger cron schedules. |
| `sixb rules` | Evaluate rules. |
| `sixb worker <type>` | Execute one kind of background job. |
| `sixb worker-group [types...]` | Run several worker types in one process. |

Worker types are `action`, `agent`, `sync`, `pipeline`, `projection`, and `workflow`. With no types, `worker-group` selects the project's registered work.

Public-origin flags have matching environment variables:

| Flag | Environment variable |
| --- | --- |
| `--api-public-origin` | `SIXB_API_PUBLIC_ORIGIN` |
| `--atlas-public-origin` | `SIXB_ATLAS_PUBLIC_ORIGIN` |
| `--app-public-origin` | `SIXB_APP_PUBLIC_ORIGIN` |

The API requires API and Atlas origins, plus the app origin when serving a built custom app. Atlas, the app server, and agent workers need the API origin. Flags override environment variables.

Schema-using services migrate storage at startup. Use `--no-migrate` or `SIXB_SKIP_MIGRATION=1` when migrations ran in a separate release step.

## Worker options

Set concurrency for one worker or per worker type in a group:

```bash
sixb worker sync --concurrency 2
sixb worker-group sync agent --concurrency sync=2 --concurrency agent=8
```

Agent workers default to 8 concurrent jobs; other types default to 1. Action workers remain serial and do not accept a concurrency override. The same per-type options work with `sixb dev`.

Set `SIXB_<TYPE>_WORKER_CONCURRENCY` to configure concurrency through the environment. Command flags take precedence. Replicas multiply the total concurrency.

Agent turns default to a 10-minute timeout. Override it with `--agent-turn-timeout 20m` or `SIXB_AGENT_TURN_TIMEOUT=20m` on `dev`, agent workers, or worker groups containing an agent worker.

## Connect to an instance

Sign in to an API and save it as a profile:

```bash
sixb login https://api.example.com --profile production
sixb status
sixb profile list
sixb profile use production
```

For an authenticated API, login opens the browser for approval. Use `--token-stdin` to supply an existing token without browser approval. A local API with authentication disabled needs no token.

Use `--profile <name>` on a remote command to select another saved instance. For automation, set `SIXB_API_URL` and `SIXB_API_TOKEN`. Use `sixb logout` to remove the selected profile.

## Query and operate

Remote commands use the selected API and its permissions:

```bash
sixb project show
sixb ontology list
sixb objects inspect Invoice inv-1
```

| Command group | Purpose |
| --- | --- |
| `objects` | Read, search, and query objects. |
| `telemetry` | Read current and historical values. |
| `actions`, `action-runs` | Request actions and inspect runs. |
| `workflows`, `workflow-runs` | Start workflows and inspect runs. |
| `files` | Upload and download files. |

These commands return JSON. Use scoped help for the operation you need, such as `sixb objects --help`.

## Tokens and service accounts

Create and revoke credentials from an authenticated user profile:

```bash
sixb token create --name "Local script" --expires-in 30d
sixb token list
sixb token revoke token-id

sixb service-account create --id finance-integration --name "Finance integration" --group finance-team
sixb service-account token create finance-integration --name "Production" --expires-in 30d
```

Use `--group` to select permitted groups and `--expires-in` or `--expires-at` to set expiration. Tokens are shown only when created. Service-account tokens cannot manage credentials themselves.

Use `--json` for machine-readable output from profile and credential commands. See [Members & service accounts](../auth/members.md) for the access model.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success or help. |
| `1` | Command or runtime failure. |
| `2` | Invalid arguments. |
| `3` | API failure. |
