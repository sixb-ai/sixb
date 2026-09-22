# Project configuration

`sixb.config.ts` configures the services your project uses: where data is stored, how background work runs, and which authentication and AI providers are available.

## Configure your project

Export the result of `createSixb()` as `sixb`. This local configuration matches the Sixb starter:

```ts
// sixb.config.ts
import { mkdirSync } from "node:fs"
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { SqliteStorage } from "@sixb/sqlite"

mkdirSync(".sixb/lake", { recursive: true })

export const sixb = createSixb({
  id: "my-app",
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new DuckLakeStorage({
    catalog: { type: "duckdb", path: ".sixb/lake/metadata.ducklake" },
    dataPath: ".sixb/lake/data",
  }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb/blobs" }),
  broker: new InMemoryBroker(),
  queues: new InMemoryQueues(),
})
```

The CLI waits for the configuration to load before starting your project. `bun sixb dev` starts the API, Atlas, your app, and background workers together.

## Required providers

Each project supplies these five providers:

| Option | Stores or handles |
| --- | --- |
| `storage` | Objects, relationships, telemetry, users, and execution history. |
| `lakeStorage` | Datasets and their versions. |
| `blobStorage` | Uploaded files and other binary content. |
| `broker` | Event delivery between parts of your project. |
| `queues` | Background jobs such as syncs, actions, and workflows. |

Choose implementations from [Infrastructure providers](../infrastructure/overview.md). In-memory messaging works locally because everything shares a process. [Production services](../deployment/overview.md) need persistent providers that they can share.

## Optional services

Add services as your project needs them:

| Option | Purpose | Guide |
| --- | --- | --- |
| `auth` | Sign-in and sessions. | [Authentication](../auth/authentication.md) |
| `models` | Language and embedding models for AI and semantic search. | [AI](../models/overview.md) |
| `sandboxes` | Execution environments for agent tools. | [Sandboxes](../sandboxes/overview.md) |
| `tools` | Your project's custom agent tools. | [Tools & skills](../models/tools-and-authorization.md) |
| `logger`, `observability` | Log output and capture settings. | [Logging](../logging/overview.md) |
| `onError` | Send failures to your monitoring service. | [Failure notifications](../logging/overview.md#report-failures) |
| `connectorConnections` | Protect stored OAuth credentials. | [OAuth connectors](../connectors/authentication.md) |

## Environment variables

Bun loads your project's `.env` file. Read credentials and environment-specific settings through `process.env`; keep secrets out of source control.

```ts
import { PostgresStorage } from "@sixb/pg"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is required")

const storage = new PostgresStorage({ connectionString })
```

Use this provider as the `storage` option. Set the same project ID, provider credentials, and OAuth encryption key across production services. Restart local development after changing environment variables.

## Project definitions

Sixb discovers exported definitions from your project's folders, including `ontology/`, `connectors/`, `actions/`, and `security/`. You do not need to list each definition in the configuration.

See [Project structure](../fundamentals/project-structure.md) for the folder conventions. Use `projectRoot` only when discovery should start somewhere other than the current working directory. Inside handlers, use the provided `sixb` context to work with project data.
