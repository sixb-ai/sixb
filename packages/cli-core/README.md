# `@sixb/cli-core`

Shared command runtime for working with a running Sixb instance.

It powers both:

```text
@sixb/cli          local profile + Bearer token
@sixb/agent-worker sandbox capability URL
```

This package has no executable and does not load profiles or environment variables. If you want
the `sixb` command, install [`@sixb/cli`](https://www.npmjs.com/package/@sixb/cli):

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
sixb telemetry latest Device device-1 temperature
sixb actions list
sixb actions request send-reminder --file input.json
sixb action-runs get run-123
sixb workflows list
sixb workflows start onboarding --file input.json
sixb workflow-runs get run-456
sixb files upload ./report.pdf
```

Run `sixb <group> --help` for exact arguments and limits.

Profile management, authentication, and server lifecycle commands belong to `@sixb/cli`.
Sandbox-only commands such as `doctor` and `context` belong to `@sixb/agent-worker`.

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

The Agent worker passes a run-scoped capability URL:

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

Sandbox mode never adds a Bearer token. Authentication is carried by the capability URL supplied
by the worker.

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
| `CliError` | Structured CLI failure with an exit code |
| `reportError` | Write the stable error envelope and return its exit code |

## Development

```bash
bun --filter @sixb/cli-core typecheck
bun --filter @sixb/cli-core test
bun --filter @sixb/cli-core build
```

Changes to shared commands must also preserve the generated Agent CLI contract on both Bun and
Node:

```bash
bun test packages/agent-worker/tests/agent-cli.test.ts
```
