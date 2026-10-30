# `@sixb/cli-core`

The commands for working with a running Sixb instance: the API half of `sixb`, for people and
agents alike.

```text
@sixb/cli          your sixb: these commands, signed in with your profile, plus the framework's
the sandbox's sixb these commands plus status, context and memory, built from src/main.ts
                   into one file the agent worker installs in every sandbox
```

If you want the `sixb` command, install [`@sixb/cli`](https://www.npmjs.com/package/@sixb/cli):

```bash
bun add --global @sixb/cli
```

## Commands

The same JSON-first commands are available in local and sandbox modes:

```bash
sixb project show
sixb ontology list
sixb ontology get Customer
sixb objects inspect Customer customer-123
sixb objects list --type Customer
sixb objects search "Northline"
sixb objects search "waterproof trail shoes" --type Product
sixb telemetry latest Device device-1 temperature
sixb actions list
sixb actions request send-reminder --file input.json
sixb action-runs get run-123
sixb workflows list
sixb workflows start onboarding --file input.json
sixb workflow-runs get run-456
sixb files upload ./report.pdf
```

`objects search` matches identifiers and full-text fields across visible types. With `--type`, it
runs a semantic search through that type's vector profile and ranks results by `score`; pass
`--vector-profile <name>` when the type declares several. `sixb ontology list` shows each type's
`vectorProfiles`.

Run `sixb <group> --help` for exact arguments and limits.

Profile management, authentication, and server lifecycle commands belong to `@sixb/cli`. Both
have `sixb status`: yours checks your profile, a sandbox's checks the sandbox and reports what the
worker's preflight expects. `sixb context` and `sixb memory` work inside an agent run only.

## Usage

Most callers need only `runInstanceCli()` and `reportError()`.

### Local mode

The caller resolves the profile and passes its API URL and token explicitly:

```ts
import { reportError, runInstanceCli } from "@sixb/cli-core"

try {
  await runInstanceCli({
    args: ["objects", "inspect", "Customer", "customer-123"],
    mode: {
      kind: "local",
      baseUrl: "https://api.example.com",
      token: "sixb_pat_...",
      profile: "production",
    },
  })
} catch (error) {
  process.exitCode = reportError(error)
}
```

Local mode sends the token as an `Authorization: Bearer ...` header. Omit `token` for an
auth-disabled instance.

### Sandbox mode

`src/main.ts` runs it with the run's API address:

```ts
import { reportError, runInstanceCli } from "@sixb/cli-core"

try {
  await runInstanceCli({
    args: process.argv.slice(2),
    mode: {
      kind: "sandbox",
      baseUrl: process.env.SIXB_API_BASE_URL ?? "",
      runContextPath: process.env.SIXB_RUN_CONTEXT ?? "",
    },
  })
} catch (error) {
  process.exitCode = reportError(error)
}
```

Sandbox mode never adds a Bearer token: the sandbox adds the run's token on the way out of
`SIXB_API_BASE_URL`, so no command holds it.

## Contract

```text
success          one JSON value plus newline on stdout
help/examples    text on stdout
errors           one {"error": ...} value on stderr
usage failure    exit 2
API failure      exit 3
downloads        atomic file write plus JSON receipt
```

The HTTP client accepts only relative `/api` paths, parses structured API errors, and never prints
credentials.

Both modes reject unknown options, missing values, duplicate scalar options, and invalid positional
counts before command I/O. Options accept `--name value` or `--name=value`. Use `--` before literal
identifiers that start with a dash. `--help` and `-h` before that separator show help even after
positionals, without reading files or contacting the API.

## Core API

```ts
import {
  CliError,
  createInstanceApiClient,
  INSTANCE_COMMANDS,
  isInstanceCommand,
  renderInstanceHelp,
  reportError,
  runInstanceCli,
} from "@sixb/cli-core"
```

| Export | Purpose |
| --- | --- |
| `runInstanceCli` | Parse and execute one instance command |
| `createInstanceApiClient` | Create the mode-aware HTTP client |
| `INSTANCE_COMMANDS` | Frozen top-level command names |
| `isInstanceCommand` | Narrow a string to an instance command |
| `renderInstanceHelp` | Render local or sandbox help text |
| `requestsHelp` | Detect help before resolving a local connection |
| `CliError` | Structured CLI failure with an exit code |
| `reportError` | Write the stable error envelope and return its exit code |
| `loadSandboxCliAssets` | The launcher and bundle the agent worker installs as a sandbox's `sixb` |

## Development

```bash
bun --filter @sixb/cli-core typecheck
bun --filter @sixb/cli-core test
bun --filter @sixb/cli-core build
```

The sandbox's `sixb` is committed as `src/generated/sixb.mjs`, and CI fails when it is stale.
Regenerate it after changing any command, then run its contract on Bun and Node:

```bash
bun run generate:sandbox-cli
bun test packages/cli-core/tests/sandbox-cli.test.ts
```
